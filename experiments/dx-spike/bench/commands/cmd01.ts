import { z } from "zod";
export const cmd01 = {
  name: "cork_cmd_01",
  description: "bench command 01",
  cliPath: ["bench", "c01"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(1) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
