import { cmd01 } from "./commands/cmd01.ts"; import { cmd02 } from "./commands/cmd02.ts"; import { cmd03 } from "./commands/cmd03.ts"; import { cmd04 } from "./commands/cmd04.ts"; import { cmd05 } from "./commands/cmd05.ts"; import { cmd06 } from "./commands/cmd06.ts"; import { cmd07 } from "./commands/cmd07.ts"; import { cmd08 } from "./commands/cmd08.ts"; import { cmd09 } from "./commands/cmd09.ts"; import { cmd10 } from "./commands/cmd10.ts"; import { cmd11 } from "./commands/cmd11.ts";
import { createCli, t } from "trpc-cli";
const defs = [cmd01,cmd02,cmd03,cmd04,cmd05,cmd06,cmd07,cmd08,cmd09,cmd10,cmd11];
const router = t.router(Object.fromEntries(defs.map(d => [d.cliPath.join(" "), t.procedure.meta({description: d.description}).input(d.input).query(({input}) => d.handler(input))])));
void createCli({ router, name: "bench", jsonInput: "auto" }).run();
