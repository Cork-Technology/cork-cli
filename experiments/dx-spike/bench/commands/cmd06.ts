import { z } from "zod";
export const cmd06 = {
  name: "cork_cmd_06",
  description: "bench command 06",
  cliPath: ["bench", "c06"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(6) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
