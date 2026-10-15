import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SecretStore {
  has(name: string): Promise<boolean>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  read(name: string): Promise<string | null>;
}

function assertName(name: string): void {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) throw new Error("INVALID_SECRET_NAME");
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async has(name: string): Promise<boolean> {
    return this.values.has(name);
  }

  async set(name: string, value: string): Promise<void> {
    assertName(name);
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }

  async read(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }
}

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(Buffer.concat(output).toString("utf8").trim())
      : reject(new Error("DPAPI_OPERATION_FAILED")));
    child.stdin.end(input);
  });
}

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$plain = [Convert]::FromBase64String($inputValue)
$cipher = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$inputValue = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($inputValue)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

export class WindowsDpapiSecretStore implements SecretStore {
  constructor(private readonly root: string) {}

  async has(name: string): Promise<boolean> {
    return (await this.readCipher(name)) !== null;
  }

  async set(name: string, value: string): Promise<void> {
    if (process.platform !== "win32") throw new Error("DPAPI_REQUIRES_WINDOWS");
    assertName(name);
    await mkdir(this.root, { recursive: true });
    const encoded = Buffer.from(value, "utf8").toString("base64");
    const protectedValue = await runPowerShell(PROTECT_SCRIPT, encoded);
    await writeFile(this.secretPath(name), protectedValue, { encoding: "utf8", mode: 0o600 });
  }

  async delete(name: string): Promise<void> {
    assertName(name);
    await rm(this.secretPath(name), { force: true });
  }

  async read(name: string): Promise<string | null> {
    if (process.platform !== "win32") throw new Error("DPAPI_REQUIRES_WINDOWS");
    const cipher = await this.readCipher(name);
    if (cipher === null) return null;
    const encoded = await runPowerShell(UNPROTECT_SCRIPT, cipher);
    return Buffer.from(encoded, "base64").toString("utf8");
  }

  private secretPath(name: string): string {
    assertName(name);
    return path.join(this.root, `${name}.dpapi`);
  }

  private async readCipher(name: string): Promise<string | null> {
    try {
      return await readFile(this.secretPath(name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
