import { z } from "zod";
export const cmd09 = {
  name: "cork_cmd_09",
  description: "bench command 09",
  cliPath: ["bench", "c09"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(9) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
