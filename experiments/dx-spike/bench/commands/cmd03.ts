import { z } from "zod";
export const cmd03 = {
  name: "cork_cmd_03",
  description: "bench command 03",
  cliPath: ["bench", "c03"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(3) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
