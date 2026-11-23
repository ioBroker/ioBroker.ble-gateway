"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUuid = normalizeUuid;
// Reduce a Bluetooth UUID to a comparable canonical form: lowercase hex without
// separators, with the 128-bit base UUID collapsed to its 16-bit short form.
// "0000FFF1-0000-1000-8000-00805F9B34FB", "FFF1" and "fff1" all become "fff1".
function normalizeUuid(u) {
    const s = (u || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (s.length === 32 && s.startsWith('0000') && s.endsWith('00001000800000805f9b34fb')) {
        return s.slice(4, 8);
    }
    return s;
}
//# sourceMappingURL=uuid.js.map