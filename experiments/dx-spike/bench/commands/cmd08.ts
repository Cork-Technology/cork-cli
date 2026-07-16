import { z } from "zod";
export const cmd08 = {
  name: "cork_cmd_08",
  description: "bench command 08",
  cliPath: ["bench", "c08"],
  input: z.object({ a: z.string().describe("a"), n: z.number().int().default(8) }),
  output: z.object({ ok: z.boolean() }),
  handler: (_input: unknown) => ({ ok: true }),
};
