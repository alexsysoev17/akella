import { wiggle } from './functions.js';
import { z } from 'zod';
/** Serializable bounded stack machine. No source code, eval, IO, recursion or mutable state. */
export const instructionSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('constant'), value: z.number().finite().min(-1e9).max(1e9) }).strict(),
    z.object({ op: z.literal('input'), name: z.enum(['time', 'progress', 'fps', 'pi']) }).strict(),
    z.object({ op: z.literal('sample'), animationId: z.string().min(1).max(180), property: z.enum(['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY', 'opacity']), offsetSeconds: z.number().finite().min(-108000).max(108000) }).strict(),
    z.object({ op: z.literal('noise'), seed: z.number().int().min(0).max(2147483647) }).strict(),
    z.object({ op: z.enum(['sin', 'cos', 'exp', 'abs', 'neg', 'sqrt']) }).strict(),
    z.object({ op: z.enum(['add', 'sub', 'mul', 'div', 'pow', 'min', 'max', 'lt', 'gt']) }).strict(),
]);
export const programSchema = z.object({ version: z.literal(1), instructions: z.array(instructionSchema).min(1).max(256) }).strict();
export type MotionProgram = z.infer<typeof programSchema>;
export function validateProgram(program: MotionProgram) { let depth = 0; for (const i of program.instructions) {
    const arity = ['constant', 'input', 'sample'].includes(i.op) ? 0 : ['noise', 'sin', 'cos', 'exp', 'abs', 'neg', 'sqrt'].includes(i.op) ? 1 : 2;
    if (depth < arity)
        throw Error('PROGRAM_STACK_UNDERFLOW');
    depth = depth - arity + 1;
    if (depth > 64)
        throw Error('PROGRAM_STACK_LIMIT');
} if (depth !== 1)
    throw Error('PROGRAM_RESULT_ARITY'); }
export function evaluateProgram(program: MotionProgram, input: {
    time: number;
    progress: number;
    fps: number;
    sample: (id: string, property: string, offset: number) => number;
}) {
    validateProgram(program);
    const stack: number[] = [];
    for (const i of program.instructions) {
        let value: number;
        if (i.op === 'constant')
            value = i.value;
        else if (i.op === 'input')
            value = i.name === 'pi' ? Math.PI : input[i.name];
        else if (i.op === 'sample')
            value = input.sample(i.animationId, i.property, i.offsetSeconds);
        else {
            const b = stack.pop()!;
            if (['noise', 'sin', 'cos', 'exp', 'abs', 'neg', 'sqrt'].includes(i.op)) {
                value = i.op === 'noise' ? wiggle(b, 1, 1, i.seed) : i.op === 'sin' ? Math.sin(b) : i.op === 'cos' ? Math.cos(b) : i.op === 'exp' ? Math.exp(b) : i.op === 'abs' ? Math.abs(b) : i.op === 'neg' ? -b : Math.sqrt(b);
            }
            else {
                const a = stack.pop()!;
                value = i.op === 'add' ? a + b : i.op === 'sub' ? a - b : i.op === 'mul' ? a * b : i.op === 'div' ? a / b : i.op === 'pow' ? Math.pow(a, b) : i.op === 'min' ? Math.min(a, b) : i.op === 'max' ? Math.max(a, b) : i.op === 'lt' ? Number(a < b) : Number(a > b);
            }
        }
        if (!Number.isFinite(value) || Math.abs(value) > 1e9)
            throw Error('PROGRAM_NUMERIC_DOMAIN');
        stack.push(value);
    }
    return stack[0];
}
