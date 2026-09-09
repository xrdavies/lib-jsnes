export interface CpuBus {
    read(address: number): number;
    write(address: number, value: number): void;
}
const C = 1, Z = 2, I = 4, D = 8, B = 16, U = 32, V = 64, N = 128;
export class Cpu6502 {
    static readonly STATE_SIZE = 15;
    a = 0;
    x = 0;
    y = 0;
    sp = 0xfd;
    p = U | I;
    pc = 0;
    cycles = 0;
    unknownOpcodes = 0;
    lastUnknownOpcode = -1;
    readonly unknownOpcodeCounts = new Uint32Array(256);
    private pageCycles = 0;
    constructor(private readonly bus: CpuBus, private readonly strict = false) { }
    reset(): void { this.sp = 0xfd; this.p = U | I; this.pc = this.read16(0xfffc); this.cycles = 0; this.unknownOpcodes = 0; this.lastUnknownOpcode = -1; this.unknownOpcodeCounts.fill(0); }
    save(): number[] {
        if (!Number.isSafeInteger(this.cycles) || this.cycles < 0) throw new RangeError('Invalid CPU cycle count');
        const bytes = new Uint8Array(Cpu6502.STATE_SIZE);
        bytes.set([this.a, this.x, this.y, this.sp, this.p, this.pc & 255, this.pc >>> 8]);
        new DataView(bytes.buffer).setFloat64(7, this.cycles, true);
        return Array.from(bytes);
    }
    static validateState(v: number[]): void {
        if (v.length !== Cpu6502.STATE_SIZE) throw new RangeError('Invalid CPU state');
        for (const value of v) {
            if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Invalid CPU state');
        }
        const cycles = new DataView(Uint8Array.from(v).buffer).getFloat64(7, true);
        if (!Number.isSafeInteger(cycles) || cycles < 0) throw new RangeError('Invalid CPU state cycle count');
    }
    load(v: number[]): void {
        Cpu6502.validateState(v);
        [this.a, this.x, this.y, this.sp, this.p] = v;
        this.pc = v[5] | (v[6] << 8);
        this.cycles = new DataView(Uint8Array.from(v).buffer).getFloat64(7, true);
    }
    irq(): boolean { if (this.p & I) return false; this.interrupt(0xfffe); return true; }
    nmi(): boolean { this.interrupt(0xfffa); return true; }
    step(): number {
        this.pageCycles = 0;
        const op = this.fetch();
        let used = 2;
        switch (op) {
            case 0xea: this.bus.read(this.pc); break;
            case 0xa9: this.a = this.imm(); this.nz(this.a); used = 2; break;
            case 0xa2: this.x = this.imm(); this.nz(this.x); used = 2; break;
            case 0xa0: this.y = this.imm(); this.nz(this.y); used = 2; break;
            case 0xa1: this.a = this.bus.read(this.indX()); this.nz(this.a); used = 6; break;
            case 0xb1: this.a = this.bus.read(this.indY(true)); this.nz(this.a); used = 5; break;
            case 0xb5: this.a = this.bus.read(this.zpx()); this.nz(this.a); used = 4; break;
            case 0xb6: this.x = this.bus.read(this.zpy()); this.nz(this.x); used = 4; break;
            case 0xb4: this.y = this.bus.read(this.zpx()); this.nz(this.y); used = 4; break;
            case 0xbe: this.x = this.bus.read(this.absy(true)); this.nz(this.x); used = 4; break;
            case 0xb9: this.a = this.bus.read(this.absy(true)); this.nz(this.a); used = 4; break;
            case 0xae: this.x = this.bus.read(this.abs()); this.nz(this.x); used = 4; break;
            case 0xac: this.y = this.bus.read(this.abs()); this.nz(this.y); used = 4; break;
            case 0xbc: this.y = this.bus.read(this.absx(true)); this.nz(this.y); used = 4; break;
            case 0x8d: this.bus.write(this.abs(), this.a); used = 4; break;
            case 0x8e: this.bus.write(this.abs(), this.x); used = 4; break;
            case 0x8c: this.bus.write(this.abs(), this.y); used = 4; break;
            case 0x81: this.bus.write(this.indX(), this.a); used = 6; break;
            case 0x91: this.bus.write(this.indY(), this.a); used = 6; break;
            case 0x95: this.bus.write(this.zpx(), this.a); used = 4; break;
            case 0x96: this.bus.write(this.zpy(), this.x); used = 4; break;
            case 0x94: this.bus.write(this.zpx(), this.y); used = 4; break;
            case 0x9d: this.bus.write(this.absx(), this.a); used = 5; break;
            case 0x99: this.bus.write(this.absy(), this.a); used = 5; break;
            case 0xad: this.a = this.bus.read(this.abs()); this.nz(this.a); used = 4; break;
            case 0xbd: this.a = this.bus.read(this.absx(true)); this.nz(this.a); used = 4; break;
            case 0xe8: this.bus.read(this.pc); this.x = (this.x + 1) & 255; this.nz(this.x); used = 2; break;
            case 0xca: this.bus.read(this.pc); this.x = (this.x - 1) & 255; this.nz(this.x); used = 2; break;
            case 0xc8: this.bus.read(this.pc); this.y = (this.y + 1) & 255; this.nz(this.y); used = 2; break;
            case 0x88: this.bus.read(this.pc); this.y = (this.y - 1) & 255; this.nz(this.y); used = 2; break;
            case 0x4c: this.pc = this.abs(); used = 3; break;
            case 0x6c: { const a = this.abs(), lo = this.bus.read(a), hi = this.bus.read((a & 0xff00) | ((a + 1) & 255)); this.pc = lo | (hi << 8); used = 5; break; }
            case 0x20: {
                const low = this.fetch();
                this.bus.read(0x100 | this.sp);
                this.push(this.pc >>> 8); this.push(this.pc);
                this.pc = low | (this.fetch() << 8); used = 6; break;
            }
            case 0x60:
                this.preparePull(); this.pc = this.pop() | (this.pop() << 8);
                this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xffff;
                used = 6; break;
            case 0x00: this.fetch(); this.push(this.pc >>> 8); this.push(this.pc); this.push(this.p | B | U); this.p |= I; this.pc = this.read16(0xfffe); used = 7; break;
            case 0x40: this.preparePull(); this.p = (this.pop() | U) & ~B; this.pc = this.pop() | (this.pop() << 8); used = 6; break;
            case 0x68: this.preparePull(); this.a = this.pop(); this.nz(this.a); used = 4; break;
            case 0x08: this.bus.read(this.pc); this.push(this.p | B | U); used = 3; break;
            case 0x28: this.preparePull(); this.p = (this.pop() | U) & ~B; used = 4; break;
            case 0x69: this.adc(this.imm()); used = 2; break;
            case 0xe9: this.adc(this.imm() ^ 255); used = 2; break;
            case 0x65: this.adc(this.bus.read(this.fetch())); used = 3; break;
            case 0x75: this.adc(this.bus.read(this.zpx())); used = 4; break;
            case 0x6d: this.adc(this.bus.read(this.abs())); used = 4; break;
            case 0x7d: this.adc(this.bus.read(this.absx(true))); used = 4; break;
            case 0x79: this.adc(this.bus.read(this.absy(true))); used = 4; break;
            case 0x61: this.adc(this.bus.read(this.indX())); used = 6; break;
            case 0x71: this.adc(this.bus.read(this.indY(true))); used = 5; break;
            case 0xe5: this.adc(this.bus.read(this.fetch()) ^ 255); used = 3; break;
            case 0xf5: this.adc(this.bus.read(this.zpx()) ^ 255); used = 4; break;
            case 0xed: this.adc(this.bus.read(this.abs()) ^ 255); used = 4; break;
            case 0xfd: this.adc(this.bus.read(this.absx(true)) ^ 255); used = 4; break;
            case 0xf9: this.adc(this.bus.read(this.absy(true)) ^ 255); used = 4; break;
            case 0xe1: this.adc(this.bus.read(this.indX()) ^ 255); used = 6; break;
            case 0xf1: this.adc(this.bus.read(this.indY(true)) ^ 255); used = 5; break;
            case 0x29: this.a &= this.imm(); this.nz(this.a); used = 2; break;
            case 0x24: { const v = this.bus.read(this.fetch()); this.p = (this.p & ~(N | V | Z)) | (v & 128) | ((v & 64) ? V : 0) | ((this.a & v) ? 0 : Z); used = 3; break; }
            case 0x2c: { const v = this.bus.read(this.abs()); this.p = (this.p & ~(N | V | Z)) | (v & 128) | ((v & 64) ? V : 0) | ((this.a & v) ? 0 : Z); used = 4; break; }
            case 0x09: this.a |= this.imm(); this.nz(this.a); used = 2; break;
            case 0x49: this.a ^= this.imm(); this.nz(this.a); used = 2; break;
            case 0x31: this.a &= this.bus.read(this.indY(true)); this.nz(this.a); used = 5; break;
            case 0x11: this.a |= this.bus.read(this.indY(true)); this.nz(this.a); used = 5; break;
            case 0x51: this.a ^= this.bus.read(this.indY(true)); this.nz(this.a); used = 5; break;
            case 0x3d: this.a &= this.bus.read(this.absx(true)); this.nz(this.a); used = 4; break;
            case 0x1d: this.a |= this.bus.read(this.absx(true)); this.nz(this.a); used = 4; break;
            case 0x5d: this.a ^= this.bus.read(this.absx(true)); this.nz(this.a); used = 4; break;
            case 0x39: this.a &= this.bus.read(this.absy(true)); this.nz(this.a); used = 4; break;
            case 0x19: this.a |= this.bus.read(this.absy(true)); this.nz(this.a); used = 4; break;
            case 0x59: this.a ^= this.bus.read(this.absy(true)); this.nz(this.a); used = 4; break;
            case 0x21: this.a &= this.bus.read(this.indX()); this.nz(this.a); used = 6; break;
            case 0x01: this.a |= this.bus.read(this.indX()); this.nz(this.a); used = 6; break;
            case 0x41: this.a ^= this.bus.read(this.indX()); this.nz(this.a); used = 6; break;
            case 0x25: this.a &= this.bus.read(this.fetch()); this.nz(this.a); used = 3; break;
            case 0x05: this.a |= this.bus.read(this.fetch()); this.nz(this.a); used = 3; break;
            case 0x45: this.a ^= this.bus.read(this.fetch()); this.nz(this.a); used = 3; break;
            case 0x35: this.a &= this.bus.read(this.zpx()); this.nz(this.a); used = 4; break;
            case 0x15: this.a |= this.bus.read(this.zpx()); this.nz(this.a); used = 4; break;
            case 0x55: this.a ^= this.bus.read(this.zpx()); this.nz(this.a); used = 4; break;
            case 0x2d: this.a &= this.bus.read(this.abs()); this.nz(this.a); used = 4; break;
            case 0x0d: this.a |= this.bus.read(this.abs()); this.nz(this.a); used = 4; break;
            case 0x4d: this.a ^= this.bus.read(this.abs()); this.nz(this.a); used = 4; break;
            case 0xc9: this.compare(this.a, this.imm()); used = 2; break;
            case 0xc5: this.compare(this.a, this.bus.read(this.fetch())); used = 3; break;
            case 0xd5: this.compare(this.a, this.bus.read(this.zpx())); used = 4; break;
            case 0xcd: this.compare(this.a, this.bus.read(this.abs())); used = 4; break;
            case 0xdd: this.compare(this.a, this.bus.read(this.absx(true))); used = 4; break;
            case 0xd9: this.compare(this.a, this.bus.read(this.absy(true))); used = 4; break;
            case 0xc1: this.compare(this.a, this.bus.read(this.indX())); used = 6; break;
            case 0xd1: this.compare(this.a, this.bus.read(this.indY(true))); used = 5; break;
            case 0xe0: this.compare(this.x, this.imm()); used = 2; break;
            case 0xc0: this.compare(this.y, this.imm()); used = 2; break;
            case 0xe4: this.compare(this.x, this.bus.read(this.fetch())); used = 3; break;
            case 0xec: this.compare(this.x, this.bus.read(this.abs())); used = 4; break;
            case 0xc4: this.compare(this.y, this.bus.read(this.fetch())); used = 3; break;
            case 0xcc: this.compare(this.y, this.bus.read(this.abs())); used = 4; break;
            case 0x85: this.bus.write(this.fetch(), this.a); used = 3; break;
            case 0x86: this.bus.write(this.fetch(), this.x); used = 3; break;
            case 0x84: this.bus.write(this.fetch(), this.y); used = 3; break;
            case 0xa5: this.a = this.bus.read(this.fetch()); this.nz(this.a); used = 3; break;
            case 0xa6: this.x = this.bus.read(this.fetch()); this.nz(this.x); used = 3; break;
            case 0xa4: this.y = this.bus.read(this.fetch()); this.nz(this.y); used = 3; break;
            case 0x1a: this.bus.read(this.pc); break;
            case 0x3a: this.bus.read(this.pc); break;
            case 0xe6: { const a = this.fetch(), v = (this.readForModify(a) + 1) & 255; this.bus.write(a, v); this.nz(v); used = 5; break; }
            case 0xc6: { const a = this.fetch(), v = (this.readForModify(a) - 1) & 255; this.bus.write(a, v); this.nz(v); used = 5; break; }
            case 0xee: { const a = this.abs(), v = (this.readForModify(a) + 1) & 255; this.bus.write(a, v); this.nz(v); used = 6; break; }
            case 0xf6: { const a = this.zpx(), v = (this.readForModify(a) + 1) & 255; this.bus.write(a, v); this.nz(v); used = 6; break; }
            case 0xce: { const a = this.abs(), v = (this.readForModify(a) - 1) & 255; this.bus.write(a, v); this.nz(v); used = 6; break; }
            case 0xd6: { const a = this.zpx(), v = (this.readForModify(a) - 1) & 255; this.bus.write(a, v); this.nz(v); used = 6; break; }
            case 0x0a: this.bus.read(this.pc); this.a = this.shift(this.a, false); used = 2; break;
            case 0x4a: this.bus.read(this.pc); this.a = this.shift(this.a, true); used = 2; break;
            case 0x2a: this.bus.read(this.pc); this.a = this.rotate(this.a, false); used = 2; break;
            case 0x6a: this.bus.read(this.pc); this.a = this.rotate(this.a, true); used = 2; break;
            case 0x06: { const a = this.fetch(); this.bus.write(a, this.shift(this.readForModify(a), false)); used = 5; break; }
            case 0x46: { const a = this.fetch(); this.bus.write(a, this.shift(this.readForModify(a), true)); used = 5; break; }
            case 0x26: { const a = this.fetch(); this.bus.write(a, this.rotate(this.readForModify(a), false)); used = 5; break; }
            case 0x66: { const a = this.fetch(); this.bus.write(a, this.rotate(this.readForModify(a), true)); used = 5; break; }
            case 0x0e: { const a = this.abs(); this.bus.write(a, this.shift(this.readForModify(a), false)); used = 6; break; }
            case 0x4e: { const a = this.abs(); this.bus.write(a, this.shift(this.readForModify(a), true)); used = 6; break; }
            case 0x2e: { const a = this.abs(); this.bus.write(a, this.rotate(this.readForModify(a), false)); used = 6; break; }
            case 0x6e: { const a = this.abs(); this.bus.write(a, this.rotate(this.readForModify(a), true)); used = 6; break; }
            case 0x16: { const a = this.zpx(); this.bus.write(a, this.shift(this.readForModify(a), false)); used = 6; break; }
            case 0x56: { const a = this.zpx(); this.bus.write(a, this.shift(this.readForModify(a), true)); used = 6; break; }
            case 0x36: { const a = this.zpx(); this.bus.write(a, this.rotate(this.readForModify(a), false)); used = 6; break; }
            case 0x76: { const a = this.zpx(); this.bus.write(a, this.rotate(this.readForModify(a), true)); used = 6; break; }
            case 0x1e: { const a = this.absx(); this.bus.write(a, this.shift(this.readForModify(a), false)); used = 7; break; }
            case 0x5e: { const a = this.absx(); this.bus.write(a, this.shift(this.readForModify(a), true)); used = 7; break; }
            case 0x3e: { const a = this.absx(); this.bus.write(a, this.rotate(this.readForModify(a), false)); used = 7; break; }
            case 0x7e: { const a = this.absx(); this.bus.write(a, this.rotate(this.readForModify(a), true)); used = 7; break; }
            case 0xaa: this.bus.read(this.pc); this.x = this.a; this.nz(this.x); used = 2; break;
            case 0xba: this.bus.read(this.pc); this.x = this.sp; this.nz(this.x); used = 2; break;
            case 0x9a: this.bus.read(this.pc); this.sp = this.x; used = 2; break;
            case 0x48: this.bus.read(this.pc); this.push(this.a); used = 3; break;
            case 0x8a: this.bus.read(this.pc); this.a = this.x; this.nz(this.a); used = 2; break;
            case 0xa8: this.bus.read(this.pc); this.y = this.a; this.nz(this.y); used = 2; break;
            case 0x98: this.bus.read(this.pc); this.a = this.y; this.nz(this.a); used = 2; break;
            case 0x18: this.bus.read(this.pc); this.p &= ~C; used = 2; break;
            case 0x90: used = this.branch(!(this.p & C)); break;
            case 0xb0: used = this.branch(!!(this.p & C)); break;
            case 0x50: used = this.branch(!(this.p & V)); break;
            case 0x70: used = this.branch(!!(this.p & V)); break;
            case 0x38: this.bus.read(this.pc); this.p |= C; used = 2; break;
            case 0x58: this.bus.read(this.pc); this.p &= ~I; used = 2; break;
            case 0x78: this.bus.read(this.pc); this.p |= I; used = 2; break;
            case 0xb8: this.bus.read(this.pc); this.p &= ~V; used = 2; break;
            case 0xd8: this.bus.read(this.pc); this.p &= ~D; used = 2; break;
            case 0xf8: this.bus.read(this.pc); this.p |= D; used = 2; break;
            case 0xd0: used = this.branch(!(this.p & Z)); break;
            case 0xf0: used = this.branch(!!(this.p & Z)); break;
            case 0x10: used = this.branch(!(this.p & N)); break;
            case 0x30: used = this.branch(!!(this.p & N)); break;
            case 0x07: this.slo(this.fetch()); used = 5; break;
            case 0x0f: this.slo(this.abs()); used = 6; break;
            case 0x17: this.slo(this.zpx()); used = 6; break;
            case 0x1f: this.slo(this.absx()); used = 7; break;
            case 0x13: this.slo(this.indY()); used = 8; break;
            case 0x27: this.rla(this.fetch()); used = 5; break;
            case 0x2f: this.rla(this.abs()); used = 6; break;
            case 0x37: this.rla(this.zpx()); used = 6; break;
            case 0x3f: this.rla(this.absx()); used = 7; break;
            case 0x33: this.rla(this.indY()); used = 8; break;
            case 0x47: this.sre(this.fetch()); used = 5; break;
            case 0x4f: this.sre(this.abs()); used = 6; break;
            case 0x57: this.sre(this.zpx()); used = 6; break;
            case 0x5f: this.sre(this.absx()); used = 7; break;
            case 0x67: this.rra(this.fetch()); used = 5; break;
            case 0x6f: this.rra(this.abs()); used = 6; break;
            case 0x77: this.rra(this.zpx()); used = 6; break;
            case 0x7f: this.rra(this.absx()); used = 7; break;
            case 0xc7: this.dcp(this.fetch()); used = 5; break;
            case 0xcf: this.dcp(this.abs()); used = 6; break;
            case 0xd7: this.dcp(this.zpx()); used = 6; break;
            case 0xdf: this.dcp(this.absx()); used = 7; break;
            case 0xe7: this.isc(this.fetch()); used = 5; break;
            case 0xef: this.isc(this.abs()); used = 6; break;
            case 0xf7: this.isc(this.zpx()); used = 6; break;
            case 0xfe: { const a = this.absx(), v = (this.readForModify(a) + 1) & 255; this.bus.write(a, v); this.nz(v); used = 7; break; }
            case 0xff: this.isc(this.absx()); used = 7; break;
            case 0x80: this.fetch(); used = 2; break;
            case 0x82: this.fetch(); used = 2; break;
            case 0x89: this.fetch(); used = 2; break;
            case 0xc2: this.fetch(); used = 2; break;
            case 0xe2: this.fetch(); used = 2; break;
            case 0xeb: this.adc(this.imm() ^ 255); used = 2; break;
            case 0xa3: this.a = this.x = this.bus.read(this.indX()); this.nz(this.a); used = 6; break;
            case 0xa7: this.a = this.x = this.bus.read(this.fetch()); this.nz(this.a); used = 3; break;
            case 0xaf: this.a = this.x = this.bus.read(this.abs()); this.nz(this.a); used = 4; break;
            case 0xb3: this.a = this.x = this.bus.read(this.indY(true)); this.nz(this.a); used = 5; break;
            case 0xb7: this.a = this.x = this.bus.read(this.zpy()); this.nz(this.a); used = 4; break;
            case 0x87: this.bus.write(this.fetch(), this.a & this.x); used = 3; break;
            case 0x8f: this.bus.write(this.abs(), this.a & this.x); used = 4; break;
            case 0x97: this.bus.write(this.zpy(), this.a & this.x); used = 4; break;
            case 0x1b: this.slo(this.absy()); used = 7; break;
            case 0x23: this.rla(this.indX()); used = 8; break;
            case 0x3b: this.rla(this.absy()); used = 7; break;
            case 0x43: this.sre(this.indX()); used = 8; break;
            case 0x53: this.sre(this.indY()); used = 8; break;
            case 0x5b: this.sre(this.absy()); used = 7; break;
            case 0x63: this.rra(this.indX()); used = 8; break;
            case 0x73: this.rra(this.indY()); used = 8; break;
            case 0x7b: this.rra(this.absy()); used = 7; break;
            case 0xc3: this.dcp(this.indX()); used = 8; break;
            case 0xd3: this.dcp(this.indY()); used = 8; break;
            case 0xdb: this.dcp(this.absy()); used = 7; break;
            case 0xe3: this.isc(this.indX()); used = 8; break;
            case 0xbf: this.a = this.x = this.bus.read(this.absy(true)); this.nz(this.a); used = 4; break;
            case 0x03: { const a = this.indX(); const v = this.shift(this.readForModify(a), false); this.bus.write(a, v); this.a |= v; this.nz(this.a); used = 8; break; }
            case 0x0b:
            case 0x2b: this.a &= this.fetch(); this.nz(this.a); this.p = (this.p & ~C) | (this.a >>> 7); used = 2; break;
            case 0x4b: this.a = this.shift(this.a & this.imm(), true); used = 2; break;
            case 0x6b:
                this.a = this.rotate(this.a & this.imm(), true);
                this.p = (this.p & ~(C | V)) | ((this.a >>> 6) & 1)
                    | ((((this.a >>> 6) ^ (this.a >>> 5)) & 1) << 6);
                used = 2; break;
            case 0xcb: {
                const difference = (this.a & this.x) - this.imm();
                this.x = difference & 255; this.nz(this.x);
                this.p = (this.p & ~C) | (difference >= 0 ? C : 0);
                used = 2; break;
            }
            case 0xdc: this.bus.read(this.absx(true)); used = 4; break;
            case 0xfb: this.isc(this.absy()); used = 7; break;
            case 0xf3: this.isc(this.indY()); used = 8; break;
            case 0xfc: this.bus.read(this.absx(true)); used = 4; break;
            case 0x54: this.bus.read(this.zpx()); used = 4; break;
            case 0x34: this.bus.read(this.zpx()); used = 4; break;
            case 0x83: { this.bus.write(this.indX(), this.a & this.x); used = 6; break; }
            case 0xde: { const a = this.absx(), v = (this.readForModify(a) - 1) & 255; this.bus.write(a, v); this.nz(v); used = 7; break; }
            case 0xda: this.bus.read(this.pc); break;
            case 0xfa: this.bus.read(this.pc); break;
            case 0x5a: this.bus.read(this.pc); break;
            case 0x7a: this.bus.read(this.pc); break;
            case 0xf4: this.bus.read(this.zpx()); used = 4; break;
            case 0x74: this.bus.read(this.zpx()); used = 4; break;
            case 0xd4: this.bus.read(this.zpx()); used = 4; break;
            case 0x04:
            case 0x44:
            case 0x64: this.bus.read(this.fetch()); used = 3; break;
            case 0x14: this.bus.read(this.zpx()); used = 4; break;
            case 0x0c: this.bus.read(this.abs()); used = 4; break;
            case 0x1c:
            case 0x3c:
            case 0x5c:
            case 0x7c: this.bus.read(this.absx(true)); used = 4; break;
            default:
                this.unknownOpcodes++;
                this.lastUnknownOpcode = op;
                this.unknownOpcodeCounts[op]++;
                if (this.strict) throw new Error(`Unsupported opcode: $${op.toString(16).padStart(2, '0')}`);
                used = 2;
                break;
        }
        used += this.pageCycles;
        this.cycles += used;
        return used;
    }
    private fetch() { const v = this.bus.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
    private imm() { return this.fetch(); }
    private abs() { const lo = this.fetch(), hi = this.fetch(); return lo | (hi << 8); }
    private indexed(base: number, index: number, penalty: boolean): number {
        const address = (base + index) & 0xffff;
        // Stores and RMW instructions always read the provisional address; reads
        // do so only when correcting the high byte after a page crossing.
        if (!penalty || (base & 0xff00) !== (address & 0xff00)) {
            if (penalty) this.pageCycles++;
            this.bus.read((base & 0xff00) | (address & 255));
        }
        return address;
    }
    private absx(penalty = false) { return this.indexed(this.abs(), this.x, penalty); }
    private absy(penalty = false) { return this.indexed(this.abs(), this.y, penalty); }
    private indexedZeroPage(index: number): number {
        const base = this.fetch();
        this.bus.read(base); // Discard the unindexed read before adding X or Y.
        return (base + index) & 255;
    }
    private zpx() { return this.indexedZeroPage(this.x); }
    private zpy() { return this.indexedZeroPage(this.y); }
    private indX() { const a = this.zpx(); return this.bus.read(a) | (this.bus.read((a + 1) & 255) << 8); }
    private indY(penalty = false) { const a = this.fetch(), base = this.bus.read(a) | (this.bus.read((a + 1) & 255) << 8); return this.indexed(base, this.y, penalty); }
    private read16(a: number) { return this.bus.read(a) | (this.bus.read((a + 1) & 0xffff) << 8); }
    private interrupt(vector: number) { this.bus.read(this.pc); this.bus.read(this.pc); this.push(this.pc >>> 8); this.push(this.pc); this.push(this.p & ~B | U); this.p |= I; this.pc = this.read16(vector); }
    private push(v: number) { this.bus.write(0x100 | this.sp, v); this.sp = (this.sp - 1) & 255; }
    private preparePull(): void { this.bus.read(this.pc); this.bus.read(0x100 | this.sp); }
    private pop() { this.sp = (this.sp + 1) & 255; return this.bus.read(0x100 | this.sp); }
    private nz(v: number) { this.p = (this.p & ~(N | Z)) | (v ? 0 : Z) | (v & 128); }
    private readForModify(address: number) { const value=this.bus.read(address); this.bus.write(address,value); return value; }
    private slo(a: number) { const v = this.shift(this.readForModify(a), false); this.bus.write(a, v); this.a |= v; this.nz(this.a); }
    private rla(a: number) { const v = this.rotate(this.readForModify(a), false); this.bus.write(a, v); this.a &= v; this.nz(this.a); }
    private sre(a: number) { const v = this.shift(this.readForModify(a), true); this.bus.write(a, v); this.a ^= v; this.nz(this.a); }
    private rra(a: number) { const v = this.rotate(this.readForModify(a), true); this.bus.write(a, v); this.adc(v); }
    private dcp(a: number) { const v = (this.readForModify(a) - 1) & 255; this.bus.write(a, v); this.compare(this.a, v); }
    private isc(a: number) { const v = (this.readForModify(a) + 1) & 255; this.bus.write(a, v); this.adc(v ^ 255); }
    private shift(v: number, right: boolean) { this.p = (this.p & ~C) | (right ? (v & 1) : ((v >> 7) & 1)); v = right ? v >> 1 : (v << 1) & 255; this.nz(v); return v; }
    private rotate(v: number, right: boolean) { const c = this.p & C ? 1 : 0; this.p = (this.p & ~C) | (right ? (v & 1) : ((v >> 7) & 1)); v = right ? (v >> 1) | (c << 7) : ((v << 1) & 255) | c; this.nz(v); return v; }
    private compare(reg: number, v: number) { const d = (reg - v) & 255; this.p = (this.p & ~C) | (reg >= v ? C : 0); this.nz(d); }
    private adc(v: number) { const sum = this.a + v + (this.p & C ? 1 : 0); this.p = (this.p & ~(C | V)) | (sum > 255 ? C : 0) | ((~(this.a ^ v) & (this.a ^ sum) & 128) ? V : 0); this.a = sum & 255; this.nz(this.a); }
    private branch(ok: boolean): number {
        const offset = (this.fetch() << 24) >> 24;
        if (!ok) return 2;
        const next = this.pc, target = (next + offset) & 0xffff;
        this.bus.read(next); // Discard the prefetched opcode when taking the branch.
        const crossesPage = (next & 0xff00) !== (target & 0xff00);
        if (crossesPage) this.bus.read((next & 0xff00) | (target & 255));
        this.pc = target;
        return crossesPage ? 4 : 3;
    }
}
