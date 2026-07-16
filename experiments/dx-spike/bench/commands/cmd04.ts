import { z } from "zod";
export const cmd04 = {
  name: "cork_cmd_04",
  description: "bench command 04",
  cliPath: ["bench", "c04"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(4) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
