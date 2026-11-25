// Users file from the command line, inside either container:
//   node <dist>/access/cli.js bootstrap-admin --email you@company.com [--name "Your Name"] [--provider local|oidc]
//   node <dist>/access/cli.js list
//   node <dist>/access/cli.js reset-password --email someone@company.com
// The file is WEAVE_USERS_FILE. Passwords are typed (hidden) or piped on stdin; never an argument.
import { createInterface } from "node:readline";
import { bootstrapAdmin } from "./plugin.js";
import { hashPassword, passwordProblem } from "./passwords.js";
import { normEmail, UserStore, type Provider } from "./userStore.js";
import { createAuditLog } from "./audit.js";
import { dirname, join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    out._writeToOutput = (s: string) => { if (!muted) process.stdout.write(s); };
    rl.question(prompt, (v) => { rl.close(); process.stdout.write("\n"); resolve(v); });
    muted = true;
  });
}

async function newPassword(): Promise<string> {
  const a = await readSecret("New password (at least 12 characters): ");
  const why = passwordProblem(a);
  if (why) throw new Error(why);
  if (process.stdin.isTTY) { const b = await readSecret("Type it again: "); if (a !== b) throw new Error("the two passwords differ"); }
  return a;
}

async function main() {
  const file = process.env.WEAVE_USERS_FILE;
  if (!file) throw new Error("WEAVE_USERS_FILE is not set");
  const users = new UserStore(file);
  const audit = createAuditLog(process.env.WEAVE_AUDIT_FILE || join(dirname(file), "audit.jsonl"), "cli");
  const cmd = process.argv[2];
  if (cmd === "list") {
    for (const u of users.read().users) console.log(`${u.disabled ? "off" : "on "}  ${u.provider.padEnd(5)}  ${u.email}  [${u.roles.join(", ")}]`);
    return;
  }
  if (cmd === "bootstrap-admin") {
    const provider = (arg("provider") ?? "local") as Provider;
    const password = provider === "local" ? await newPassword() : undefined;
    const r = await bootstrapAdmin(users, { email: arg("email"), name: arg("name"), provider, password });
    if (r.skipped) { console.log(`Nothing done: ${r.skipped}.`); return; }
    audit.write({ user: "bootstrap (command line)", action: "user.create", target: r.created!.email, detail: `first admin (${provider})` });
    console.log(`Admin ${r.created!.email} (${provider}) is ready.`);
    return;
  }
  if (cmd === "reset-password") {
    const email = normEmail(arg("email") ?? "");
    if (!users.match("local", email)) throw new Error("no Weave account with that e-mail");
    const hash = await hashPassword(await newPassword());
    users.update((d) => { const r = d.users.find((u) => u.provider === "local" && normEmail(u.email) === email); if (r) { r.passwordHash = hash; r.updatedAt = new Date().toISOString(); } });
    audit.write({ user: "command line", action: "user.password-reset", target: email });
    console.log("Password changed.");
    return;
  }
  console.log("Use: bootstrap-admin --email <e-mail> [--name <name>] [--provider local|oidc] | list | reset-password --email <e-mail>");
  process.exitCode = 2;
}

main().catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
