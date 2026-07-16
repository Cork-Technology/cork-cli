import { z } from "zod";
export const cmd11 = {
  name: "cork_cmd_11",
  description: "bench command 11",
  cliPath: ["bench", "c11"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(11) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
