import { z } from "zod";
export const cmd10 = {
  name: "cork_cmd_10",
  description: "bench command 10",
  cliPath: ["bench", "c10"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(10) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
