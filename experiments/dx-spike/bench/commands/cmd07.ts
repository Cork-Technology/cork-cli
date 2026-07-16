import { z } from "zod";
export const cmd07 = {
  name: "cork_cmd_07",
  description: "bench command 07",
  cliPath: ["bench", "c07"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(7) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
