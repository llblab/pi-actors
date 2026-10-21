import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workflow = (await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const step = workflow.split("      - name: Verify public npm package and packed manifest\n")[1]
  ?.split("\n      - name: ")[0];
assert.ok(step, "The maintained npm verification step must exist");
const body = step.split("        run: |\n")[1];
assert.ok(body, "The verification step must contain its executable shell contract");
const script = body.split("\n").map(line => {
  assert.ok(!line || line.startsWith("          "), "Unexpected workflow shell indentation");
  return line.slice(10);
}).join("\n");
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const posix = { skip: process.platform === "win32" ? "Release verification runs on Ubuntu Bash" : false };
const metadata = {
  version: "1.2.3", gitHead: "a".repeat(40),
  pi: { extensions: ["./dist/pi-actors/index.js"], skills: ["./dist/skills"] },
};
const packed = [{ name: "@fixture/package", version: "1.2.3", files: [
  { path: "package.json" }, { path: "dist/pi-actors/index.js" }, { path: "dist/skills/actors/SKILL.md" },
] }];

async function verify(options: {
  viewFailures?: number;
  packFailures?: number;
  viewElapsed?: number;
  metadata?: unknown;
  packed?: unknown;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-actors-release-verification-"));
  // Replace only the clock; execute the actual workflow policy and JSON validation.
  const controlledScript = script.replaceAll(/\bSECONDS\b/g, "TEST_SECONDS");
  const prelude = `
TEST_SECONDS=0
view_calls=0
pack_calls=0
trap 'printf "COUNTS view=%s pack=%s seconds=%s\\n" "$view_calls" "$pack_calls" "$TEST_SECONDS" >&2' EXIT
sleep() { TEST_SECONDS=$((TEST_SECONDS + $1)); }
node() { ${shellQuote(process.execPath)} "$@"; }
timeout() {
  test "$1" = --kill-after=5s || exit 95
  shift
  test "\${1%s}" -gt 0 || exit 96
  shift
  "$@"
}
npm() {
  test "$2" = "$PACKAGE_NAME@$VERSION" || exit 97
  case " $* " in *" --prefer-online "*) ;; *) exit 98 ;; esac
  case "$1" in
    view)
      view_calls=$((view_calls + 1))
      if [ "$view_calls" -le ${options.viewFailures ?? 0} ]; then
        echo 'npm error E404: accepted version is still processing' >&2
        return 1
      fi
      TEST_SECONDS=$((TEST_SECONDS + ${options.viewElapsed ?? 0}))
      printf '%s\\n' ${shellQuote(JSON.stringify(options.metadata ?? metadata))}
      ;;
    pack)
      pack_calls=$((pack_calls + 1))
      if [ "$pack_calls" -le ${options.packFailures ?? 0} ]; then
        echo 'npm error ETARGET: tarball is not available yet' >&2
        return 1
      fi
      printf '%s\\n' ${shellQuote(JSON.stringify(options.packed ?? packed))}
      ;;
    *) echo 'Verification must never publish' >&2; exit 99 ;;
  esac
}
`;
  try {
    const result = await execFileAsync("bash", ["-e", "-c", prelude + controlledScript], {
      cwd: root,
      env: { ...process.env, PACKAGE_NAME: "@fixture/package", VERSION: metadata.version, TAG_COMMIT: metadata.gitHead },
      timeout: 10_000,
    }).then(
      output => ({ ...output, code: 0 }),
      (error: { code: number | string; stdout: string; stderr: string }) => {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      },
    );
    const counts = /COUNTS view=(\d+) pack=(\d+) seconds=(\d+)/.exec(result.stderr);
    assert.ok(counts, result.stderr);
    return { ...result, views: Number(counts[1]), packs: Number(counts[2]), elapsed: Number(counts[3]) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("npm verification accepts metadata delayed beyond the old retry window", posix, async () => {
  const result = await verify({ viewFailures: 24 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([result.views, result.packs, result.elapsed], [25, 1, 240]);
  assert.match(result.stdout, /waiting without republishing/);
  assert.match(result.stdout, /Verified public npm package @fixture\/package@1\.2\.3/);
});

test("npm verification waits for the packed artifact after metadata becomes public", posix, async () => {
  const result = await verify({ packFailures: 2 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([result.views, result.packs, result.elapsed], [3, 3, 20]);
});

test("npm verification stops at its deadline without republishing an accepted version", posix, async () => {
  const result = await verify({ viewFailures: 1_000 });
  assert.equal(result.code, 1);
  assert.deepEqual([result.views, result.packs, result.elapsed], [60, 0, 600]);
  assert.match(result.stdout, /Do not republish or move the tag/);
  assert.match(result.stderr, /E404/);
  assert.doesNotMatch(result.stdout, /Verified public npm package/);
});

test("npm verification rechecks the deadline before starting another registry command", posix, async () => {
  const result = await verify({ viewElapsed: 600 });
  assert.equal(result.code, 1);
  assert.deepEqual([result.views, result.packs, result.elapsed], [1, 0, 600]);
});

for (const [name, options] of [
  ["a different version", { metadata: { ...metadata, version: "1.2.4" } }],
  ["a different gitHead", { metadata: { ...metadata, gitHead: "b".repeat(40) } }],
  ["missing Pi metadata", { metadata: { ...metadata, pi: {} } }],
  ["missing packed runtime files", { packed: [{ ...packed[0], files: [] }] }],
] as const) {
  test(`npm verification fails immediately on ${name}`, posix, async () => {
    const result = await verify(options);
    assert.equal(result.code, 1);
    assert.deepEqual([result.views, result.packs, result.elapsed], [1, 1, 0]);
    assert.doesNotMatch(result.stdout, /waiting without republishing|Verified public npm package/);
  });
}
