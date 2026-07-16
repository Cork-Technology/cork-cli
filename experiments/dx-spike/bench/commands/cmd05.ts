import { z } from "zod";
export const cmd05 = {
  name: "cork_cmd_05",
  description: "bench command 05",
  cliPath: ["bench", "c05"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(5) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
