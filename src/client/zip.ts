import type { ReceiveSink } from './transfer.js';

/**
 * A streaming ZIP writer.
 *
 * Files arrive over the data channel one chunk at a time and must reach disk
 * without ever being held whole in memory, which rules out any library that
 * wants a Blob per entry. Two format features make that possible:
 *
 *   - STORE (no compression). The payload is passed through untouched, so a
 *     chunk can be written the moment it arrives. Most things people send are
 *     already compressed anyway, so this costs little in practice.
 *   - Data descriptors (general purpose bit 3). A CRC-32 is only known after
 *     the last byte, so the local header writes zeroes and the real CRC and
 *     sizes follow the payload.
 *
 * Because the manifest gives us every file size in advance, the exact archive
 * length is known before the first byte is written - which means the browser
 * gets a Content-Length and shows a true progress bar rather than a spinner.
 */

// --- CRC-32 -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

class Crc32 {
  private crc = 0xffffffff;

  update(data: Uint8Array): void {
    let crc = this.crc;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ (data[i] as number)) & 0xff]! ^ (crc >>> 8);
    }
    this.crc = crc;
  }

  get value(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}

// --- Little-endian buffer writer --------------------------------------------

class ByteWriter {
  private readonly view: DataView;
  private offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(value: number): this {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.offset += 4;
    return this;
  }

  /** ZIP64 fields are 8 bytes; sizes here comfortably fit in a JS number. */
  u64(value: number): this {
    this.view.setUint32(this.offset, value >>> 0, true);
    this.view.setUint32(this.offset + 4, Math.floor(value / 2 ** 32), true);
    this.offset += 8;
    return this;
  }

  raw(data: Uint8Array): this {
    this.bytes.set(data, this.offset);
    this.offset += data.length;
    return this;
  }
}

// --- Planning ---------------------------------------------------------------

export interface ZipFileSpec {
  name: string;
  size: number;
}

interface PlannedEntry {
  name: string;
  nameBytes: Uint8Array;
  size: number;
  /** Filled in as the archive is written. */
  crc: number;
  offset: number;
}

export interface ZipPlan {
  entries: PlannedEntry[];
  zip64: boolean;
  totalSize: number;
}

const U32_MAX = 0xffffffff;
const LOCAL_HEADER_BASE = 30;
const CENTRAL_HEADER_BASE = 46;
const EOCD_SIZE = 22;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
/** Zip64 extended information in a local header: sizes only. */
const ZIP64_LOCAL_EXTRA = 20;
/** Zip64 extended information in a central header: sizes plus offset. */
const ZIP64_CENTRAL_EXTRA = 28;

const encoder = new TextEncoder();

/**
 * Two files can legitimately arrive with the same name; an archive with
 * duplicate paths confuses extractors, so disambiguate the later ones.
 */
function uniqueNames(files: ZipFileSpec[]): string[] {
  const seen = new Map<string, number>();
  return files.map((file) => {
    // Defence in depth: an entry name must never escape the extraction dir.
    const base = file.name.replace(/[\\/]/g, '_').replace(/^\.+/, '_') || 'file';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if (count === 0) return base;
    const dot = base.lastIndexOf('.');
    return dot > 0
      ? `${base.slice(0, dot)} (${count})${base.slice(dot)}`
      : `${base} (${count})`;
  });
}

export function planZip(files: ZipFileSpec[]): ZipPlan {
  const names = uniqueNames(files);
  const entries: PlannedEntry[] = files.map((file, i) => ({
    name: names[i] as string,
    nameBytes: encoder.encode(names[i] as string),
    size: file.size,
    crc: 0,
    offset: 0,
  }));

  // Decide the format once, for the whole archive: mixing zip64 and classic
  // entries is legal but needlessly fiddly, and a uniform choice reads better.
  const payload = entries.reduce((sum, e) => sum + e.size, 0);
  const namesLength = entries.reduce((sum, e) => sum + e.nameBytes.length, 0);
  const roughSize = payload + namesLength
    + entries.length * (LOCAL_HEADER_BASE + CENTRAL_HEADER_BASE + 24);
  const zip64 = entries.some((e) => e.size > U32_MAX)
    || roughSize > U32_MAX
    || entries.length > 0xffff;

  const localExtra = zip64 ? ZIP64_LOCAL_EXTRA : 0;
  const centralExtra = zip64 ? ZIP64_CENTRAL_EXTRA : 0;
  const descriptorSize = zip64 ? 24 : 16;

  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    offset += LOCAL_HEADER_BASE + entry.nameBytes.length + localExtra
      + entry.size + descriptorSize;
  }

  const centralSize = entries.reduce(
    (sum, e) => sum + CENTRAL_HEADER_BASE + e.nameBytes.length + centralExtra, 0);
  const tail = zip64 ? ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE + EOCD_SIZE : EOCD_SIZE;

  return { entries, zip64, totalSize: offset + centralSize + tail };
}

// --- Writing ----------------------------------------------------------------

function dosDateTime(date = new Date()): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Bit 3: sizes/CRC follow in a data descriptor. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const METHOD_STORE = 0;

export class ZipWriter {
  private readonly stamp = dosDateTime();
  private index = 0;
  private written = 0;
  private finished = false;

  constructor(
    private readonly plan: ZipPlan,
    private readonly sink: ReceiveSink,
  ) {}

  /** Exact final size of the archive, known before anything is written. */
  get totalSize(): number {
    return this.plan.totalSize;
  }

  get bytesWritten(): number {
    return this.written;
  }

  private async emit(bytes: Uint8Array): Promise<void> {
    this.written += bytes.length;
    // The sink takes an ArrayBuffer and may transfer it onward, so hand over a
    // buffer that is exactly this view. Every caller here allocates precisely,
    // but a partial view would otherwise send the wrong bytes silently.
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : bytes.slice().buffer as ArrayBuffer;
    await this.sink.write(exact);
  }

  private get versionNeeded(): number {
    return this.plan.zip64 ? 45 : 20;
  }

  /**
   * Opens the next entry and returns a sink for its bytes. Closing that sink
   * finalises the entry; the caller then moves on to the next file.
   */
  nextEntry(): ReceiveSink {
    const entry = this.plan.entries[this.index];
    if (!entry) throw new Error('No entry left in this archive.');
    this.index += 1;

    const crc = new Crc32();
    let received = 0;
    let headerWritten = false;

    const writeHeader = async (): Promise<void> => {
      const extra = this.plan.zip64 ? ZIP64_LOCAL_EXTRA : 0;
      const buf = new Uint8Array(LOCAL_HEADER_BASE + entry.nameBytes.length + extra);
      const w = new ByteWriter(buf);
      w.u32(0x04034b50)
        .u16(this.versionNeeded)
        .u16(FLAGS)
        .u16(METHOD_STORE)
        .u16(this.stamp.time)
        .u16(this.stamp.date)
        .u32(0)               // CRC-32, in the data descriptor
        .u32(0)               // compressed size, likewise
        .u32(0)               // uncompressed size, likewise
        .u16(entry.nameBytes.length)
        .u16(extra)
        .raw(entry.nameBytes);
      if (this.plan.zip64) {
        // Placeholder sizes; the real values follow the payload.
        w.u16(0x0001).u16(16).u64(0).u64(0);
      }
      await this.emit(buf);
    };

    return {
      write: async (chunk: ArrayBuffer) => {
        if (!headerWritten) {
          headerWritten = true;
          await writeHeader();
        }
        const bytes = new Uint8Array(chunk);
        crc.update(bytes);
        received += bytes.length;
        await this.emit(bytes);
      },

      close: async () => {
        // A zero-byte file never triggers write(), so make sure it still exists.
        if (!headerWritten) {
          headerWritten = true;
          await writeHeader();
        }
        entry.crc = crc.value;

        const buf = new Uint8Array(this.plan.zip64 ? 24 : 16);
        const w = new ByteWriter(buf);
        w.u32(0x08074b50).u32(entry.crc);
        if (this.plan.zip64) w.u64(received).u64(received);
        else w.u32(received).u32(received);
        await this.emit(buf);

        if (received !== entry.size) {
          throw new Error(
            `${entry.name}: expected ${entry.size} bytes but received ${received}.`);
        }
      },

      abort: async (reason: string) => {
        await this.sink.abort(reason);
      },
    };
  }

  /** Writes the central directory and closes the underlying sink. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    const centralStart = this.written;

    for (const entry of this.plan.entries) {
      const extra = this.plan.zip64 ? ZIP64_CENTRAL_EXTRA : 0;
      const buf = new Uint8Array(CENTRAL_HEADER_BASE + entry.nameBytes.length + extra);
      const w = new ByteWriter(buf);
      w.u32(0x02014b50)
        .u16((3 << 8) | this.versionNeeded)  // made by UNIX
        .u16(this.versionNeeded)
        .u16(FLAGS)
        .u16(METHOD_STORE)
        .u16(this.stamp.time)
        .u16(this.stamp.date)
        .u32(entry.crc)
        .u32(this.plan.zip64 ? U32_MAX : entry.size)
        .u32(this.plan.zip64 ? U32_MAX : entry.size)
        .u16(entry.nameBytes.length)
        .u16(extra)
        .u16(0)                              // comment length
        .u16(0)                              // disk number
        .u16(0)                              // internal attributes
        .u32(0o644 << 16)                    // external attributes
        .u32(this.plan.zip64 ? U32_MAX : entry.offset)
        .raw(entry.nameBytes);
      if (this.plan.zip64) {
        w.u16(0x0001).u16(24).u64(entry.size).u64(entry.size).u64(entry.offset);
      }
      await this.emit(buf);
    }

    const centralSize = this.written - centralStart;
    const count = this.plan.entries.length;

    if (this.plan.zip64) {
      const buf = new Uint8Array(ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE);
      const w = new ByteWriter(buf);
      w.u32(0x06064b50)
        .u64(ZIP64_EOCD_SIZE - 12)           // size of this record, less 12
        .u16((3 << 8) | 45)
        .u16(45)
        .u32(0).u32(0)                       // this disk, disk with central dir
        .u64(count).u64(count)
        .u64(centralSize).u64(centralStart)
        // Zip64 end of central directory locator
        .u32(0x07064b50).u32(0).u64(centralStart + centralSize).u32(1);
      await this.emit(buf);
    }

    const eocd = new Uint8Array(EOCD_SIZE);
    new ByteWriter(eocd)
      .u32(0x06054b50)
      .u16(0).u16(0)
      .u16(this.plan.zip64 ? 0xffff : count)
      .u16(this.plan.zip64 ? 0xffff : count)
      .u32(this.plan.zip64 ? U32_MAX : centralSize)
      .u32(this.plan.zip64 ? U32_MAX : centralStart)
      .u16(0);
    await this.emit(eocd);

    await this.sink.close();

    if (this.written !== this.plan.totalSize) {
      // The plan drives Content-Length, so a mismatch would truncate the file.
      throw new Error(
        `Archive size mismatch: wrote ${this.written}, planned ${this.plan.totalSize}.`);
    }
  }
}
