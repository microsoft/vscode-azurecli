/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Minimal JMESPath implementation
// Reference: https://jmespath.org/specification.html

export class ParserError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ParserError';
    }
}

// ---- Lexer ----

interface Token { t: string; v: any; }

function lex(expr: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const len = expr.length;

    while (i < len) {
        const c = expr[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

        if (c === '.') { tokens.push({ t: 'dot', v: '.' }); i++; }
        else if (c === '*') { tokens.push({ t: 'star', v: '*' }); i++; }
        else if (c === ',') { tokens.push({ t: 'comma', v: ',' }); i++; }
        else if (c === ':') { tokens.push({ t: 'colon', v: ':' }); i++; }
        else if (c === '@') { tokens.push({ t: 'current', v: '@' }); i++; }
        else if (c === '{') { tokens.push({ t: 'lbrace', v: '{' }); i++; }
        else if (c === '}') { tokens.push({ t: 'rbrace', v: '}' }); i++; }
        else if (c === '(') { tokens.push({ t: 'lparen', v: '(' }); i++; }
        else if (c === ')') { tokens.push({ t: 'rparen', v: ')' }); i++; }
        else if (c === ']') { tokens.push({ t: 'rbracket', v: ']' }); i++; }
        else if (c === '&' && expr[i + 1] === '&') { tokens.push({ t: 'and', v: '&&' }); i += 2; }
        else if (c === '&') { tokens.push({ t: 'expref', v: '&' }); i++; }
        else if (c === '|' && expr[i + 1] === '|') { tokens.push({ t: 'or', v: '||' }); i += 2; }
        else if (c === '|') { tokens.push({ t: 'pipe', v: '|' }); i++; }
        else if (c === '!' && expr[i + 1] === '=') { tokens.push({ t: 'ne', v: '!=' }); i += 2; }
        else if (c === '!') { tokens.push({ t: 'not', v: '!' }); i++; }
        else if (c === '<' && expr[i + 1] === '=') { tokens.push({ t: 'lte', v: '<=' }); i += 2; }
        else if (c === '<') { tokens.push({ t: 'lt', v: '<' }); i++; }
        else if (c === '>' && expr[i + 1] === '=') { tokens.push({ t: 'gte', v: '>=' }); i += 2; }
        else if (c === '>') { tokens.push({ t: 'gt', v: '>' }); i++; }
        else if (c === '=' && expr[i + 1] === '=') { tokens.push({ t: 'eq', v: '==' }); i += 2; }
        else if (c === '=') { throw new ParserError(`Unexpected '=' at position ${i}`); }
        else if (c === '[' && expr[i + 1] === '?') { tokens.push({ t: 'filter', v: '[?' }); i += 2; }
        else if (c === '[' && expr[i + 1] === ']') { tokens.push({ t: 'flatten', v: '[]' }); i += 2; }
        else if (c === '[') { tokens.push({ t: 'lbracket', v: '[' }); i++; }
        else if (c === '`') {
            const start = i++;
            let raw = '';
            while (i < len && expr[i] !== '`') {
                if (expr[i] === '\\' && expr[i + 1] === '`') { raw += '`'; i += 2; }
                else { raw += expr[i++]; }
            }
            if (i >= len) { throw new ParserError(`Unclosed literal at position ${start}`); }
            i++;
            try { tokens.push({ t: 'literal', v: JSON.parse(raw) }); }
            catch { throw new ParserError(`Invalid JSON literal at position ${start}`); }
        }
        else if (c === "'") {
            const start = i++;
            let raw = '';
            while (i < len && expr[i] !== "'") {
                if (expr[i] === '\\' && expr[i + 1] === "'") { raw += "'"; i += 2; }
                else { raw += expr[i++]; }
            }
            if (i >= len) { throw new ParserError(`Unclosed string at position ${start}`); }
            i++;
            tokens.push({ t: 'literal', v: raw });
        }
        else if (c === '"') {
            const start = i++;
            let raw = '';
            while (i < len && expr[i] !== '"') {
                if (expr[i] === '\\' && i + 1 < len) {
                    raw += jsonUnescape(expr[i + 1]);
                    i += 2;
                } else { raw += expr[i++]; }
            }
            if (i >= len) { throw new ParserError(`Unclosed quoted identifier at position ${start}`); }
            i++;
            tokens.push({ t: 'qid', v: raw });
        }
        else if (isDigit(c) || (c === '-' && i + 1 < len && isDigit(expr[i + 1]))) {
            let numStr = c === '-' ? '-' : '';
            if (c === '-') { i++; }
            while (i < len && isDigit(expr[i])) { numStr += expr[i++]; }
            tokens.push({ t: 'number', v: parseInt(numStr, 10) });
        }
        else if (isIdStart(c)) {
            let id = '';
            while (i < len && isIdChar(expr[i])) { id += expr[i++]; }
            tokens.push({ t: 'id', v: id });
        }
        else {
            throw new ParserError(`Unexpected character '${c}' at position ${i}`);
        }
    }

    tokens.push({ t: 'eof', v: null });
    return tokens;
}

function jsonUnescape(ch: string): string {
    const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    return map[ch] ?? ch;
}

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isIdStart(c: string): boolean { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isIdChar(c: string): boolean { return isIdStart(c) || isDigit(c); }

// ---- AST ----

type Node =
    | { type: 'identity' }
    | { type: 'current' }
    | { type: 'field'; name: string }
    | { type: 'literal'; value: any }
    | { type: 'subexpr'; left: Node; right: Node }
    | { type: 'index'; node: Node; idx: number }
    | { type: 'slice'; node: Node; start: number | null; stop: number | null; step: number | null }
    | { type: 'list_projection'; node: Node; right: Node }
    | { type: 'obj_projection'; node: Node; right: Node }
    | { type: 'flatten_projection'; node: Node; right: Node }
    | { type: 'filter_projection'; node: Node; condition: Node; right: Node }
    | { type: 'multi_list'; exprs: Node[] }
    | { type: 'multi_hash'; keys: string[]; values: Node[] }
    | { type: 'pipe'; left: Node; right: Node }
    | { type: 'or'; left: Node; right: Node }
    | { type: 'and'; left: Node; right: Node }
    | { type: 'not'; expr: Node }
    | { type: 'comparator'; op: string; left: Node; right: Node }
    | { type: 'func'; name: string; args: Node[] }
    | { type: 'expref'; expr: Node };

// ---- Parser ----

// Binding powers match the JMESPath reference implementation
const BP: Record<string, number> = {
    pipe: 1, or: 2, and: 3,
    eq: 5, ne: 5, lt: 5, lte: 5, gt: 5, gte: 5,
    flatten: 9, star: 20, filter: 21,
    dot: 40, not: 45, lbrace: 50, lbracket: 55,
    current: 60, expref: 60,
};

class Parser {
    private pos = 0;
    constructor(private tokens: Token[]) { }

    parse(): Node {
        const node = this.expr(0);
        if (this.cur().t !== 'eof') {
            throw new ParserError(`Unexpected token '${this.cur().v}' at position ${this.pos}`);
        }
        return node;
    }

    private cur(): Token { return this.tokens[this.pos]; }
    private advance(): Token { return this.tokens[this.pos++]; }
    private expect(t: string): Token {
        const tok = this.advance();
        if (tok.t !== t) { throw new ParserError(`Expected '${t}', got '${tok.t}'`); }
        return tok;
    }
    private bp(t: string): number { return BP[t] ?? 0; }

    expr(minBp: number): Node {
        let left = this.nud(this.advance());
        while (minBp < this.bp(this.cur().t)) {
            left = this.led(left, this.advance());
        }
        return left;
    }

    private nud(tok: Token): Node {
        switch (tok.t) {
            case 'id':
                if (this.cur().t === 'lparen') { return this.parseFunc(tok.v as string); }
                return { type: 'field', name: tok.v as string };
            case 'qid':
                return { type: 'field', name: tok.v as string };
            case 'literal':
            case 'number':
                return { type: 'literal', value: tok.v };
            case 'current':
                return { type: 'current' };
            case 'star':
                return { type: 'obj_projection', node: { type: 'identity' }, right: this.projRHS(20) };
            case 'not':
                return { type: 'not', expr: this.expr(45) };
            case 'expref':
                return { type: 'expref', expr: this.expr(60) };
            case 'lbrace':
                return this.parseMultiHash();
            case 'lbracket': {
                const t = this.cur().t;
                if (t === 'number' || t === 'colon') {
                    return this.parseIndexOrSlice({ type: 'identity' });
                }
                if (t === 'star' && this.tokens[this.pos + 1]?.t === 'rbracket') {
                    this.advance(); this.expect('rbracket');
                    return { type: 'list_projection', node: { type: 'identity' }, right: this.projRHS(20) };
                }
                return this.parseMultiList();
            }
            case 'filter': {
                const cond = this.expr(0);
                this.expect('rbracket');
                return { type: 'filter_projection', node: { type: 'identity' }, condition: cond, right: this.projRHS(21) };
            }
            case 'flatten':
                return { type: 'flatten_projection', node: { type: 'identity' }, right: this.projRHS(9) };
            default:
                throw new ParserError(`Unexpected token '${tok.t}' (value: ${JSON.stringify(tok.v)})`);
        }
    }

    private led(left: Node, tok: Token): Node {
        switch (tok.t) {
            case 'dot': {
                const t = this.cur().t;
                if (t === 'star') {
                    this.advance();
                    return { type: 'obj_projection', node: left, right: this.projRHS(20) };
                }
                if (t === 'lbrace') {
                    this.advance();
                    return { type: 'subexpr', left, right: this.parseMultiHash() };
                }
                if (t === 'lbracket') {
                    this.advance();
                    const inner = this.cur().t;
                    if (inner === 'number' || inner === 'colon') {
                        return this.parseIndexOrSlice(left);
                    }
                    if (inner === 'star' && this.tokens[this.pos + 1]?.t === 'rbracket') {
                        this.advance(); this.expect('rbracket');
                        return { type: 'list_projection', node: left, right: this.projRHS(20) };
                    }
                    return { type: 'subexpr', left, right: this.parseMultiList() };
                }
                if (t === 'filter') {
                    this.advance();
                    const cond = this.expr(0);
                    this.expect('rbracket');
                    return { type: 'filter_projection', node: left, condition: cond, right: this.projRHS(21) };
                }
                const idTok = this.advance();
                if (idTok.t !== 'id' && idTok.t !== 'qid') {
                    throw new ParserError(`Expected identifier after '.', got '${idTok.t}'`);
                }
                const right: Node = this.cur().t === 'lparen'
                    ? this.parseFunc(idTok.v as string)
                    : { type: 'field', name: idTok.v as string };
                return { type: 'subexpr', left, right };
            }
            case 'pipe':
                return { type: 'pipe', left, right: this.expr(1) };
            case 'or':
                return { type: 'or', left, right: this.expr(2) };
            case 'and':
                return { type: 'and', left, right: this.expr(3) };
            case 'eq': case 'ne': case 'lt': case 'lte': case 'gt': case 'gte':
                return { type: 'comparator', op: tok.v as string, left, right: this.expr(5) };
            case 'lbracket': {
                const t = this.cur().t;
                if (t === 'number' || t === 'colon') {
                    return this.parseIndexOrSliceAsProjection(left);
                }
                if (t === 'star' && this.tokens[this.pos + 1]?.t === 'rbracket') {
                    this.advance(); this.expect('rbracket');
                    return { type: 'list_projection', node: left, right: this.projRHS(20) };
                }
                return { type: 'subexpr', left, right: this.parseMultiList() };
            }
            case 'filter': {
                const cond = this.expr(0);
                this.expect('rbracket');
                return { type: 'filter_projection', node: left, condition: cond, right: this.projRHS(21) };
            }
            case 'flatten':
                return { type: 'flatten_projection', node: left, right: this.projRHS(9) };
            default:
                throw new ParserError(`Unexpected infix token '${tok.t}'`);
        }
    }

    // Parse [n], [n:m], [n:m:s], [:m] etc. with node as the source
    // Plain index returns an index node; slice returns a list_projection
    private parseIndexOrSlice(node: Node): Node {
        if (this.cur().t === 'colon') {
            return this.buildSliceProjection(node, null);
        }
        const num = this.expect('number');
        if (this.cur().t === 'colon') {
            return this.buildSliceProjection(node, num.v as number);
        }
        this.expect('rbracket');
        return { type: 'index', node, idx: num.v as number };
    }

    // Used when we know a leading `[` has already been consumed via led; same logic but
    // an index followed by nothing should still project if its source is a list context.
    // We keep the same behaviour as parseIndexOrSlice.
    private parseIndexOrSliceAsProjection(node: Node): Node {
        return this.parseIndexOrSlice(node);
    }

    private buildSliceProjection(node: Node, start: number | null): Node {
        this.expect('colon');
        let stop: number | null = null;
        let step: number | null = null;
        if (this.cur().t === 'number') { stop = this.advance().v as number; }
        if (this.cur().t === 'colon') {
            this.advance();
            if (this.cur().t === 'number') { step = this.advance().v as number; }
        }
        this.expect('rbracket');
        const sliceNode: Node = { type: 'slice', node, start, stop, step };
        return { type: 'list_projection', node: sliceNode, right: this.projRHS(20) };
    }

    // Parse the right-hand side of a projection; bp is the projection's binding power.
    // Operations with higher bp are captured into the projection; lower ones are left for
    // the outer expression to handle.
    private projRHS(bp: number): Node {
        const t = this.cur().t;
        if (t === 'dot') {
            this.advance(); // consume '.'
            const next = this.cur().t;
            if (next === 'star') {
                this.advance();
                return { type: 'obj_projection', node: { type: 'identity' }, right: this.projRHS(20) };
            }
            if (next === 'lbrace') {
                this.advance();
                return this.parseMultiHash();
            }
            if (next === 'lbracket') {
                this.advance();
                return this.parseIndexOrSliceAsProjection({ type: 'identity' });
            }
            if (next === 'filter') {
                this.advance();
                const cond = this.expr(0);
                this.expect('rbracket');
                return { type: 'filter_projection', node: { type: 'identity' }, condition: cond, right: this.projRHS(21) };
            }
            // identifier (+ optional function call or chained operations)
            return this.expr(bp);
        }
        if (this.bp(t) > bp) {
            return this.expr(bp);
        }
        return { type: 'identity' };
    }

    private parseMultiList(): Node {
        const exprs: Node[] = [];
        while (this.cur().t !== 'rbracket' && this.cur().t !== 'eof') {
            exprs.push(this.expr(0));
            if (this.cur().t === 'comma') { this.advance(); }
        }
        this.expect('rbracket');
        return { type: 'multi_list', exprs };
    }

    private parseMultiHash(): Node {
        const keys: string[] = [];
        const values: Node[] = [];
        while (this.cur().t !== 'rbrace' && this.cur().t !== 'eof') {
            const keyTok = this.advance();
            if (keyTok.t !== 'id' && keyTok.t !== 'qid' && keyTok.t !== 'literal') {
                throw new ParserError(`Expected key in multi-select hash, got '${keyTok.t}'`);
            }
            keys.push(String(keyTok.v));
            this.expect('colon');
            values.push(this.expr(0));
            if (this.cur().t === 'comma') { this.advance(); }
        }
        this.expect('rbrace');
        return { type: 'multi_hash', keys, values };
    }

    private parseFunc(name: string): Node {
        this.expect('lparen');
        const args: Node[] = [];
        while (this.cur().t !== 'rparen' && this.cur().t !== 'eof') {
            if (this.cur().t === 'expref') {
                this.advance();
                args.push({ type: 'expref', expr: this.expr(0) });
            } else {
                args.push(this.expr(0));
            }
            if (this.cur().t === 'comma') { this.advance(); }
        }
        this.expect('rparen');
        return { type: 'func', name, args };
    }
}

// ---- Evaluator ----

function evaluate(node: Node, data: any): any {
    switch (node.type) {
        case 'identity': return data;
        case 'current': return data;
        case 'literal': return node.value;
        case 'field': {
            if (data === null || typeof data !== 'object' || Array.isArray(data)) { return null; }
            const v = (data as Record<string, any>)[node.name];
            return v === undefined ? null : v;
        }
        case 'subexpr':
            return evaluate(node.right, evaluate(node.left, data));
        case 'index': {
            const src = evaluate(node.node, data);
            if (!Array.isArray(src)) { return null; }
            const i = node.idx < 0 ? src.length + node.idx : node.idx;
            return (i >= 0 && i < src.length) ? src[i] : null;
        }
        case 'slice': {
            const src = evaluate(node.node, data);
            if (!Array.isArray(src)) { return null; }
            return sliceArray(src, node.start, node.stop, node.step);
        }
        case 'list_projection': {
            const arr = evaluate(node.node, data);
            if (!Array.isArray(arr)) { return null; }
            const result: any[] = [];
            for (const item of arr) {
                const v = evaluate(node.right, item);
                if (v !== null && v !== undefined) { result.push(v); }
            }
            return result;
        }
        case 'obj_projection': {
            const obj = evaluate(node.node, data);
            if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) { return null; }
            const result: any[] = [];
            for (const val of Object.values(obj as Record<string, any>)) {
                const v = evaluate(node.right, val);
                if (v !== null && v !== undefined) { result.push(v); }
            }
            return result;
        }
        case 'flatten_projection': {
            const arr = evaluate(node.node, data);
            if (!Array.isArray(arr)) { return null; }
            const flat: any[] = [];
            for (const item of arr) {
                if (Array.isArray(item)) { flat.push(...item); } else { flat.push(item); }
            }
            const result: any[] = [];
            for (const item of flat) {
                const v = evaluate(node.right, item);
                if (v !== null && v !== undefined) { result.push(v); }
            }
            return result;
        }
        case 'filter_projection': {
            const arr = evaluate(node.node, data);
            if (!Array.isArray(arr)) { return null; }
            const result: any[] = [];
            for (const item of arr) {
                if (isTruthy(evaluate(node.condition, item))) {
                    const v = evaluate(node.right, item);
                    if (v !== null && v !== undefined) { result.push(v); }
                }
            }
            return result;
        }
        case 'multi_list':
            return node.exprs.map(e => evaluate(e, data));
        case 'multi_hash': {
            const obj: Record<string, any> = {};
            for (let i = 0; i < node.keys.length; i++) {
                obj[node.keys[i]] = evaluate(node.values[i], data);
            }
            return obj;
        }
        case 'pipe':
            return evaluate(node.right, evaluate(node.left, data));
        case 'or': {
            const l = evaluate(node.left, data);
            return isTruthy(l) ? l : evaluate(node.right, data);
        }
        case 'and': {
            const l = evaluate(node.left, data);
            return !isTruthy(l) ? l : evaluate(node.right, data);
        }
        case 'not':
            return !isTruthy(evaluate(node.expr, data));
        case 'comparator':
            return compare(node.op, evaluate(node.left, data), evaluate(node.right, data));
        case 'func': {
            const args = node.args.map(a => evaluate(a, data));
            return callFunction(node.name, args);
        }
        case 'expref':
            return { __expref: true, expr: node.expr };
        default:
            throw new ParserError(`Unknown node type: ${(node as any).type}`);
    }
}

function isTruthy(v: any): boolean {
    if (v === null || v === false || v === undefined) { return false; }
    if (typeof v === 'string') { return v.length > 0; }
    if (Array.isArray(v)) { return v.length > 0; }
    if (typeof v === 'object') { return Object.keys(v as object).length > 0; }
    return Boolean(v);
}

function compare(op: string, l: any, r: any): boolean {
    switch (op) {
        case '==': return deepEqual(l, r);
        case '!=': return !deepEqual(l, r);
        case '<':  return typeof l === 'number' && typeof r === 'number' ? l < r : false;
        case '<=': return typeof l === 'number' && typeof r === 'number' ? l <= r : false;
        case '>':  return typeof l === 'number' && typeof r === 'number' ? l > r : false;
        case '>=': return typeof l === 'number' && typeof r === 'number' ? l >= r : false;
        default: return false;
    }
}

function deepEqual(a: any, b: any): boolean {
    if (a === b) { return true; }
    if (a === null || b === null) { return false; }
    if (typeof a !== typeof b) { return false; }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) { return false; }
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    if (typeof a === 'object' && !Array.isArray(a)) {
        const ka = Object.keys(a as object);
        const kb = Object.keys(b as object);
        if (ka.length !== kb.length) { return false; }
        return ka.every(k => deepEqual((a as Record<string, any>)[k], (b as Record<string, any>)[k]));
    }
    return false;
}

function sliceArray(arr: any[], start: number | null, stop: number | null, step: number | null): any[] {
    const len = arr.length;
    const s = step === null ? 1 : step;
    if (s === 0) { throw new ParserError('Slice step cannot be 0'); }
    let begin: number, end: number;
    if (s > 0) {
        begin = start === null ? 0 : (start < 0 ? Math.max(len + start, 0) : Math.min(start, len));
        end   = stop  === null ? len : (stop  < 0 ? Math.max(len + stop,  0) : Math.min(stop,  len));
    } else {
        begin = start === null ? len - 1 : (start < 0 ? Math.max(len + start, -1) : Math.min(start, len - 1));
        end   = stop  === null ? -(len + 1) : (stop < 0 ? Math.max(len + stop, -1) : Math.min(stop, len - 1));
    }
    const result: any[] = [];
    if (s > 0) { for (let i = begin; i < end; i += s) { result.push(arr[i]); } }
    else       { for (let i = begin; i > end; i += s) { result.push(arr[i]); } }
    return result;
}

// ---- Built-in Functions ----

function evalExpref(ref: any, item: any): any {
    if (ref && ref.__expref === true) { return evaluate(ref.expr as Node, item); }
    return ref;
}

function callFunction(name: string, args: any[]): any {
    switch (name.toLowerCase()) {
        case 'abs':
            return typeof args[0] === 'number' ? Math.abs(args[0]) : null;
        case 'avg': {
            if (!Array.isArray(args[0]) || args[0].length === 0) { return null; }
            return (args[0] as number[]).reduce((a: number, b: number) => a + b, 0) / args[0].length;
        }
        case 'ceil':
            return typeof args[0] === 'number' ? Math.ceil(args[0]) : null;
        case 'contains': {
            const [hay, needle] = args;
            if (typeof hay === 'string') { return hay.includes(String(needle)); }
            if (Array.isArray(hay)) { return hay.some(v => deepEqual(v, needle)); }
            return false;
        }
        case 'ends_with':
            return (typeof args[0] === 'string' && typeof args[1] === 'string') ? args[0].endsWith(args[1]) : false;
        case 'floor':
            return typeof args[0] === 'number' ? Math.floor(args[0]) : null;
        case 'join': {
            const [glue, arr] = args;
            if (typeof glue !== 'string' || !Array.isArray(arr)) { return null; }
            return arr.join(glue);
        }
        case 'keys':
            return (args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) ? Object.keys(args[0] as object) : null;
        case 'length': {
            const v = args[0];
            if (typeof v === 'string') { return v.length; }
            if (Array.isArray(v)) { return v.length; }
            if (v !== null && typeof v === 'object') { return Object.keys(v as object).length; }
            return null;
        }
        case 'map': {
            const [ref, arr] = args;
            if (!Array.isArray(arr) || !(ref?.__expref)) { return null; }
            return arr.map((item: any) => evalExpref(ref, item));
        }
        case 'max': {
            if (!Array.isArray(args[0]) || args[0].length === 0) { return null; }
            return (args[0] as any[]).reduce((a: any, b: any) => {
                if (typeof a === 'number' && typeof b === 'number') { return b > a ? b : a; }
                if (typeof a === 'string' && typeof b === 'string') { return b > a ? b : a; }
                return a;
            });
        }
        case 'max_by': {
            const [arr, ref] = args;
            if (!Array.isArray(arr) || arr.length === 0 || !(ref?.__expref)) { return null; }
            return arr.reduce((best: any, item: any) => {
                const bv = evalExpref(ref, best);
                const iv = evalExpref(ref, item);
                return iv > bv ? item : best;
            });
        }
        case 'merge': {
            const result: Record<string, any> = {};
            for (const arg of args) {
                if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) { Object.assign(result, arg); }
            }
            return result;
        }
        case 'min': {
            if (!Array.isArray(args[0]) || args[0].length === 0) { return null; }
            return (args[0] as any[]).reduce((a: any, b: any) => {
                if (typeof a === 'number' && typeof b === 'number') { return b < a ? b : a; }
                if (typeof a === 'string' && typeof b === 'string') { return b < a ? b : a; }
                return a;
            });
        }
        case 'min_by': {
            const [arr, ref] = args;
            if (!Array.isArray(arr) || arr.length === 0 || !(ref?.__expref)) { return null; }
            return arr.reduce((best: any, item: any) => {
                const bv = evalExpref(ref, best);
                const iv = evalExpref(ref, item);
                return iv < bv ? item : best;
            });
        }
        case 'not_null': {
            for (const arg of args) { if (arg !== null && arg !== undefined) { return arg; } }
            return null;
        }
        case 'reverse': {
            if (typeof args[0] === 'string') { return args[0].split('').reverse().join(''); }
            if (Array.isArray(args[0])) { return [...args[0]].reverse(); }
            return null;
        }
        case 'sort': {
            if (!Array.isArray(args[0])) { return null; }
            return [...args[0]].sort((a: any, b: any) => {
                if (typeof a === 'string' && typeof b === 'string') { return a < b ? -1 : a > b ? 1 : 0; }
                if (typeof a === 'number' && typeof b === 'number') { return a - b; }
                return 0;
            });
        }
        case 'sort_by': {
            const [arr, ref] = args;
            if (!Array.isArray(arr) || !(ref?.__expref)) { return null; }
            return [...arr].sort((a: any, b: any) => {
                const av = evalExpref(ref, a);
                const bv = evalExpref(ref, b);
                if (typeof av === 'string' && typeof bv === 'string') { return av < bv ? -1 : av > bv ? 1 : 0; }
                if (typeof av === 'number' && typeof bv === 'number') { return av - bv; }
                return 0;
            });
        }
        case 'starts_with':
            return (typeof args[0] === 'string' && typeof args[1] === 'string') ? args[0].startsWith(args[1]) : false;
        case 'sum':
            return Array.isArray(args[0]) ? (args[0] as number[]).reduce((a: number, b: number) => a + b, 0) : null;
        case 'to_array':
            return Array.isArray(args[0]) ? args[0] : [args[0]];
        case 'to_number': {
            if (typeof args[0] === 'number') { return args[0]; }
            if (typeof args[0] === 'string') { const n = Number(args[0]); return isNaN(n) ? null : n; }
            return null;
        }
        case 'to_string':
            return typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
        case 'type': {
            if (args[0] === null) { return 'null'; }
            if (typeof args[0] === 'boolean') { return 'boolean'; }
            if (typeof args[0] === 'number') { return 'number'; }
            if (typeof args[0] === 'string') { return 'string'; }
            if (Array.isArray(args[0])) { return 'array'; }
            return 'object';
        }
        case 'values':
            return (args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0])) ? Object.values(args[0] as object) : null;
        case 'unique_by': {
            const [arr, ref] = args;
            if (!Array.isArray(arr) || !(ref?.__expref)) { return null; }
            const seen = new Set<string>();
            return arr.filter((item: any) => {
                const key = JSON.stringify(evalExpref(ref, item));
                if (seen.has(key)) { return false; }
                seen.add(key);
                return true;
            });
        }
        case 'group_by': {
            const [arr, ref] = args;
            if (!Array.isArray(arr) || !(ref?.__expref)) { return null; }
            const result: Record<string, any[]> = {};
            for (const item of arr) {
                const key = String(evalExpref(ref, item));
                if (!result[key]) { result[key] = []; }
                result[key].push(item);
            }
            return result;
        }
        default:
            throw new ParserError(`Unknown function: ${name}`);
    }
}

// ---- Public API ----

export function search(data: any, expression: string): any {
    const tokens = lex(expression);
    const parser = new Parser(tokens);
    const ast = parser.parse();
    return evaluate(ast, data);
}
