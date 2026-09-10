'use strict';

/**
 * Escritor ZIP minimo, sin dependencias.
 *
 * BI Publisher espera los paquetes .xdmz/.xdoz como un ZIP plano (sin carpeta
 * contenedora) con nombres de archivo exactos. Node trae zlib, asi que
 * construimos el contenedor a mano y evitamos arrastrar una libreria entera.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

/** Fecha/hora en el formato empaquetado de MS-DOS que usa el formato ZIP. */
function dosDateTime(date) {
    const time =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        (Math.floor(date.getSeconds() / 2));
    const day =
        ((date.getFullYear() - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();
    return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * Crea un ZIP a partir de { nombre: contenido }.
 * El contenido puede ser string (se codifica en UTF-8) o Buffer.
 */
function createZip(files) {
    const now = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
        const nameBuf = Buffer.from(name, 'utf8');
        const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const deflated = zlib.deflateRawSync(raw, { level: 9 });
        // si comprimir no compensa, guardamos sin compresion
        const useDeflate = deflated.length < raw.length;
        const data = useDeflate ? deflated : raw;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);   // firma local file header
        local.writeUInt16LE(20, 4);           // version necesaria
        local.writeUInt16LE(0, 6);            // flags
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(now.time, 10);
        local.writeUInt16LE(now.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);           // extra field
        locals.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); // firma central directory
        central.writeUInt16LE(20, 4);         // version que lo creo
        central.writeUInt16LE(20, 6);         // version necesaria
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(now.time, 12);
        central.writeUInt16LE(now.date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);         // extra
        central.writeUInt16LE(0, 32);         // comentario
        central.writeUInt16LE(0, 34);         // disco
        central.writeUInt16LE(0, 36);         // atributos internos
        central.writeUInt32LE(0, 38);         // atributos externos
        central.writeUInt32LE(offset, 42);    // offset del local header
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralBuf, end]);
}

/** Lectura simple de un ZIP: devuelve { nombre: Buffer }. */
function readZip(buffer) {
    const out = {};
    // localizar el end-of-central-directory recorriendo desde el final
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP invalido: falta el end of central directory');

    const count = buffer.readUInt16LE(eocd + 10);
    let p = buffer.readUInt32LE(eocd + 16);

    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(p) !== 0x02014b50) break;
        const method = buffer.readUInt16LE(p + 10);
        const compSize = buffer.readUInt32LE(p + 20);
        const nameLen = buffer.readUInt16LE(p + 28);
        const extraLen = buffer.readUInt16LE(p + 30);
        const commentLen = buffer.readUInt16LE(p + 32);
        const localOffset = buffer.readUInt32LE(p + 42);
        const name = buffer.slice(p + 46, p + 46 + nameLen).toString('utf8');

        const lNameLen = buffer.readUInt16LE(localOffset + 26);
        const lExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lNameLen + lExtraLen;
        const data = buffer.slice(dataStart, dataStart + compSize);

        out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

module.exports = { createZip, readZip, crc32 };
