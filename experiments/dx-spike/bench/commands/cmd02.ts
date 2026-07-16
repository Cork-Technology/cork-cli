import { z } from "zod";
export const cmd02 = {
  name: "cork_cmd_02",
  description: "bench command 02",
  cliPath: ["bench", "c02"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(2) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
