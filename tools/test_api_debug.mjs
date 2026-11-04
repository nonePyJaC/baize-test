import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
const temp = await mkdtemp(join(tmpdir(), "baize-api-debug-"));
try {
  const file = join(temp, "fixture.mjs");
  await build({
    stdin: {
      contents: `export * from './src/lib/apiDebug';export * from './src/lib/apiScriptRuntime';export * from './src/lib/apiDebugRuntime';export * from './src/lib/apiWorkbench';`,
      resolveDir: resolve("."),
    },
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
    },
  });
  const m = await import(pathToFileURL(file));
  const rsaPair = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const pubKey = rsaPair.publicKey.replace(/-----[^-]+-----|\s/g, "");
  const rsaFixture = m.runApiScript({
    request: {
      ...m.newApiRequest(),
      url: "https://fixture.invalid",
      body: '{"keys":"fixture-input"}',
      pre_script:
        'const rs=require("jsrsasign");const key=rs.KEYUTIL.getKey(pm.environment.get("PEM"));const data=JSON.parse(pm.request.body.raw);data.token=rs.hextob64(key.encrypt(data.keys));pm.request.body.update(JSON.stringify(data));',
    },
    variables: { PEM: rsaPair.publicKey },
  });
  const rsaDecoded = privateDecrypt(
    { key: rsaPair.privateKey, padding: constants.RSA_NO_PADDING },
    Buffer.from(JSON.parse(rsaFixture.body).token, "base64"),
  );
  assert.equal(rsaDecoded[1], 2);
  assert.equal(
    rsaDecoded.subarray(rsaDecoded.indexOf(0, 2) + 1).toString("utf8"),
    "fixture-input",
  );
  const raw =
    '{// comment\n"id":16067299772662317098,"url":"https://fixture.invalid/a//b"/* note */}';
  const pretty = m.stringifyLosslessJson(m.parseLosslessJson(raw));
  assert.match(pretty, /16067299772662317098/);
  assert.match(pretty, /https:\/\/fixture.invalid\/a\/\/b/);
  assert.match(
    m.updateApiParameter(pretty, "url", "https://fixture.invalid/changed"),
    /16067299772662317098/,
  );
  assert.doesNotThrow(() =>
    m.parseLosslessJson('{"value":0.123456789012345678}'),
  );
  assert.equal(
    JSON.parse(m.updateApiParameter('{"n":1}', "n", "", true)).n,
    null,
  );
  assert.equal(
    JSON.parse(m.updateApiParameter('{"n":1}', "n", "bad-value", true)).n,
    "bad-value",
  );
  const r = {
    ...m.newApiRequest(),
    url: "https://fixture.invalid/api?b=2&A=1",
    body: '{"id":16067299772662317098}',
    signature_mode: "aliyun",
    pre_script: 'pm.globals.set("nonce-note", "fixture");',
  };
  const prepared = m.runApiScript({
    request: r,
    variables: {
      APP_KEY: "fixture-key",
      APP_SECRET: "fixture-secret",
      X_CA_STAGE: "TEST",
    },
  });
  assert.equal(prepared.body, r.body);
  assert.ok(prepared.headers.find((h) => h.key === "X-Ca-Signature")?.value);
  assert.ok(prepared.headers.find((h) => h.key === "Content-MD5")?.value);
  const mutated = m.runApiScript({
    request: {
      ...r,
      signature_mode: "script",
      pre_script:
        'pm.request.body.raw = JSON.stringify({changed: pm.environment.get("value")}); pm.request.headers.upsert({key:"X-Fixture",value:"set"});',
    },
    variables: { VALUE: "ok" },
  });
  assert.equal(mutated.body, '{"changed":"ok"}');
  assert.equal(mutated.headers.find((h) => h.key === "X-Fixture").value, "set");
  const response = {
    status: 422,
    body: '{"code":"EXPECTED","data":{"id":16067299772662317098}}',
    headers: [],
    elapsed_ms: 5,
    size: 1,
    truncated: false,
    url: r.url,
  };
  const assertions = [
    {
      id: "status",
      target: "status",
      operator: "equals",
      expected: "422",
      path: "",
    },
    {
      id: "id",
      target: "json",
      operator: "equals",
      expected: "16067299772662317098",
      path: "$.data.id",
    },
  ];
  assert.ok(
    m.evaluateApiAssertions(assertions, response).every((c) => c.passed),
  );
  assert.deepEqual(
    m.apiCaseVerdict({ outcome: "unverified", response, checks: [] }, "passed"),
    { status: "passed", resetRetest: false },
  );
  assert.deepEqual(
    m.apiCaseVerdict(
      { outcome: "passed", response, checks: [] },
      "not_executed",
    ),
    { status: "not_executed", resetRetest: false },
  );
  assert.deepEqual(
    m.apiCaseVerdict(
      { outcome: "passed", response, checks: [{ passed: true }] },
      "failed",
    ),
    { status: "passed", resetRetest: true },
  );
  assert.deepEqual(
    m.apiCaseVerdict({ outcome: "failed", checks: [] }, "not_executed"),
    { status: "blocked", resetRetest: false },
  );
  const tested = m.runApiScript({
    request: {
      ...r,
      test_script:
        'pm.test("expected status",()=>pm.response.to.have.status(422));pm.test("business code",()=>pm.expect(pm.response.json().code).to.equal("EXPECTED"));',
    },
    variables: {},
    response,
  });
  assert.equal(tested.checks.length, 2);
  assert.ok(tested.checks.every((c) => c.passed));
  const curl = m.importApiCurl(
    `curl 'https://fixture.invalid/a' -H 'Content-Type: application/json' --data-raw '{"url":"https://a/b","id":16067299772662317098}'`,
  );
  assert.equal(curl.method, "POST");
  assert.match(curl.body, /16067299772662317098/);
  const postman = {
    info: { name: "collection" },
    event: [
      {
        listen: "prerequest",
        script: { exec: ['pm.globals.set("fromParent", "yes");'] },
      },
    ],
    variable: [{ key: "base", value: "https://fixture.invalid" }],
    item: [
      {
        name: "folder",
        event: [
          {
            listen: "prerequest",
            script: { exec: ['pm.globals.set("fromFolder", "yes");'] },
          },
        ],
        item: [
          {
            name: "leaf",
            request: {
              method: "POST",
              url: "{{base}}/one",
              header: [],
              body: { mode: "raw", raw: "{}" },
            },
          },
        ],
      },
    ],
  };
  const imported = m.importApiDocument(
    JSON.stringify(postman),
    "postman-fixture",
  );
  assert.equal(imported.requests.length, 1);
  assert.match(imported.requests[0].pre_script, /fromParent[\s\S]*fromFolder/);
  let library = m.mergeApiImport(m.newApiLibrary(), imported);
  library.requests[0].name = "human edit";
  library = m.mergeApiImport(library, imported);
  assert.equal(library.requests.length, 1);
  assert.equal(library.requests[0].name, "human edit");
  const original = m.apiDebugBackend.execute;
  m.apiDebugBackend.execute = async () => response;
  const scriptRunner = async (input) => m.runApiScript(input);
  assert.equal(
    (
      await m.runApiRequest(
        { ...r, signature_mode: "script", pre_script: "", assertions },
        undefined,
        undefined,
        undefined,
        scriptRunner,
      )
    ).outcome,
    "passed",
  );
  assert.equal(
    (
      await m.runApiRequest(
        { ...r, signature_mode: "script", pre_script: "", assertions: [] },
        undefined,
        undefined,
        undefined,
        scriptRunner,
      )
    ).outcome,
    "unverified",
  );
  m.apiDebugBackend.execute = original;
  const redacted = m.redactApiExecution({
    request: {
      ...prepared,
      headers: [{ key: "Authorization", value: "fixture-token" }],
    },
    logs: ["do not publish"],
    checks: [],
    outcome: "passed",
  });
  assert.equal(redacted.request.headers[0].value, "[已隐藏]");
  assert.equal(redacted.logs.length, 0);
  // Inspect original assets without executing their business requests or writing to the source directory.
  const root = process.env.BAIZE_API_FIXTURE_ROOT;
  let actual = 0;
  if (root)
    for (const [name, expected] of [
      ["接口测试工具/data.json", 13],
      ["示例项目/Work.postman.json", 5],
      ["米米/mimi-payload-wenton.json", 1],
      ["米米/mimi-ruitong-payload-other.json", 1],
    ]) {
      const source = join(root, name);
      const data = m.importApiDocument(await readFile(source, "utf8"), source);
      assert.equal(data.requests.length, expected, name);
      actual += data.requests.length;
      if (name.includes("米米")) {
        assert.ok(data.requests[0].parameters.length >= 10);
        for (const p of data.requests[0].parameters)
          assert.notEqual(
            m.jsonPath(m.parseLosslessJson(data.requests[0].body), p.path),
            undefined,
            `米米参数路径 ${p.path}`,
          );
      }
      if (name.startsWith("接口测试工具")) {
        assert.equal(data.scripts.length, 2);
        assert.equal(data.header_templates.length, 2);
        const env = {
          APP_KEY: "fixture-key",
          APP_SECRET: "fixture-secret",
          X_CA_STAGE: "TEST",
        };
        for (const request of data.requests) {
          assert.doesNotMatch(
            request.pre_script,
            /\b(?:fetch|XMLHttpRequest|sendRequest|axios)\s*\(/,
          );
          const prepared = m.runApiScript({
            request,
            variables: { ...request.variables, ...env },
          });
          assert.ok(
            prepared.headers.some(
              (h) => h.key.toLowerCase() === "x-ca-signature",
            ),
          );
        }
      }
      if (name.startsWith("示例项目"))
        for (const request of data.requests) {
          assert.doesNotMatch(
            request.pre_script,
            /\b(?:fetch|XMLHttpRequest|sendRequest|axios)\s*\(/,
          );
          const prepared = m.runApiScript({
            request,
            variables: {
              ...request.variables,
              baseUrl: "https://fixture.invalid",
              pubKey,
            },
          });
          assert.ok(prepared.url.startsWith("http"));
          const body = JSON.parse(prepared.body);
          assert.ok(body.token);
          const decoded = privateDecrypt(
            { key: rsaPair.privateKey, padding: constants.RSA_NO_PADDING },
            Buffer.from(body.token, "base64"),
          );
          assert.equal(decoded[1], 2);
          assert.ok(decoded.indexOf(0, 2) > 9);
          assert.ok(decoded.subarray(decoded.indexOf(0, 2) + 1).length > 0);
        }
    }
  {
    const oldRequest = {
      ...m.newApiRequest(),
      id: "stable-id",
      url: "{{BASE_URL}}/echo",
      variables: { local: "one" },
    };
    const migrated = m.normalizeApiLibrary({
      ...m.newApiLibrary(),
      requests: [oldRequest],
      bindings: { case: "stable-id" },
    });
    assert.equal(migrated.bindings.case, "stable-id");
    assert.equal(migrated.requests[0].id, "stable-id");
    const firstProject = migrated.projects[0];
    const otherProject = m.newApiProject("另一个项目");
    const source = {
      requests: [oldRequest],
      environments: [{ id: "env", name: "TEST", variables: {} }],
      warnings: [],
    };
    assert.notEqual(
      m.scopeApiImport(source, firstProject.id).requests[0].id,
      m.scopeApiImport(source, otherProject.id).requests[0].id,
    );
    const project = {
      ...firstProject,
      variables: {
        BASE_URL: "https://fixture.invalid",
        TOKEN: "project-token",
      },
      auth: { type: "bearer", token: "{{TOKEN}}" },
      headers: [{ key: "X-Project", value: "one" }],
      pre_script:
        'const same="project";pm.request.headers.upsert({key:"X-Sequence",value:same});',
      test_script:
        'const same="project";pm.test(same,()=>pm.expect(pm.response.code).to.equal(200));',
    };
    const request = {
      ...migrated.requests[0],
      headers: [{ key: "X-Project", value: "override" }],
      pre_script:
        'const same="request";pm.environment.set("TOKEN","login-token");',
      test_script:
        'const same="request";pm.environment.set("EXTRACTED",pm.response.json().token);pm.test(same,()=>pm.expect(pm.response.code).to.equal(200));',
    };
    const prepared = m.runApiScript({
      request: m.projectApiRequest(request, project),
      variables: { ...project.variables, TOKEN: "environment-token" },
      environment_variables: { TOKEN: "environment-token" },
      collection_variables: project.variables,
    });
    assert.equal(
      prepared.headers.find((h) => h.key === "Authorization").value,
      "Bearer login-token",
    );
    assert.equal(
      prepared.headers.find((h) => h.key === "X-Project").value,
      "override",
    );
    assert.equal(prepared.environment_variables.TOKEN, "login-token");
    assert.equal(prepared.collection_variables.TOKEN, "project-token");
    const tested = m.runApiScript({
      request: { ...m.projectApiRequest(request, project), ...prepared },
      variables: prepared.variables,
      environment_variables: prepared.environment_variables,
      collection_variables: prepared.collection_variables,
      response: {
        status: 200,
        headers: [],
        body: '{"token":"next-token"}',
        url: prepared.url,
        elapsed_ms: 1,
        size: 22,
        truncated: false,
      },
    });
    assert.equal(tested.checks.length, 2);
    assert.equal(tested.environment_variables.EXTRACTED, "next-token");
    const queryRequest = {
      ...oldRequest,
      url: "https://fixture.invalid?a=1",
      auth: {
        type: "apikey",
        location: "query",
        key: "api_key",
        value: "{{KEY}}",
      },
    };
    assert.match(
      m.runApiScript({ request: queryRequest, variables: { KEY: "key-value" } })
        .url,
      /api_key=key-value/,
    );
    const basicAuth = m.runApiScript({
      request: {
        ...queryRequest,
        auth: { type: "basic", username: "测试", password: "pass" },
      },
      variables: {},
    });
    assert.equal(
      Buffer.from(
        basicAuth.headers.find((h) => h.key === "Authorization").value.slice(6),
        "base64",
      ).toString(),
      "测试:pass",
    );
    assert.equal(
      m.projectApiRequest({ ...request, auth: { type: "none" } }, project).auth
        .type,
      "none",
    );
    const updatedUrl = m.urlWithApiQuery("{{BASE_URL}}/echo?old=1", [
      { key: "id", value: "{{ID}}" },
      { key: "skip", value: "1", enabled: false },
    ]);
    assert.equal(updatedUrl, "{{BASE_URL}}/echo?id={{ID}}");
    assert.equal(m.apiQueryRows(updatedUrl)[0].value, "{{ID}}");
    const config = m.importApiProjectSettings(
      '{"headers":{"X-App":"{{APP_KEY}}"},"auth":{"type":"bearer","token":"{{TOKEN}}"},"variables":{"APP_KEY":"local-only"}}',
      firstProject,
    );
    assert.equal(config.headers[0].key, "X-App");
    assert.equal(config.auth.type, "bearer");
    const prompt = m.apiAiPrompt(config, undefined, "接口负向用例", "返回422");
    assert.doesNotMatch(prompt, /local-only/);
    const draft = m.parseApiAiDraft(
      '```json\n{"notes":["补齐环境"],"requests":[{"name":"负向用例","method":"POST","url":"{{BASE_URL}}/echo","body":"{}","assertions":[{"target":"status","operator":"equals","expected":"422"}]}]}\n```',
      otherProject.id,
    );
    assert.equal(draft.requests[0].project_id, otherProject.id);
    assert.equal(draft.requests[0].assertions[0].expected, "422");
    assert.throws(() =>
      m.parseApiAiDraft('{"requests":[{}]}', otherProject.id),
    );
    assert.equal(
      m.redactApiExecution({
        ...migrated.history[0],
        id: "test",
        logs: [],
        request: { url: "https://fixture.invalid", headers: [] },
        variable_updates: { environment: { TOKEN: "hidden" } },
      }).variable_updates,
      undefined,
    );
    console.log(
      "PASS: 项目迁移/隔离、鉴权继承与覆盖、前后置脚本顺序、Token 提取复用、Query/Basic/Bearer 鉴权、AI 草稿校验与本地凭据排除",
    );
  }
  console.log(
    `PASS: 导入原始 ${actual} 个接口（只读）、嵌套 Postman 脚本、米米字段路径、原工具前置脚本与网关签名、JSON 注释/长整数、cURL、负向断言、无断言不通过、重复导入保护、响应证据`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
