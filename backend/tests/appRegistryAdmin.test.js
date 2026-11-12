// App Check registry editing from Argus (services/appCheck/registryAdmin.js, utils/appRegistryAdminRouter.js):
// validation keeps the database usable by matchApp, and only the listed admin wallets may write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAppInput, hostConflicts, slugify } from "../services/appCheck/registryAdmin.js";
import { REGISTRY_ADMINS } from "../utils/appRegistryAdminRouter.js";

test("a valid app is normalised: hosts lower-cased and cleaned, one primary, contracts lower-case", () => {
  const v = validateAppInput({
    name: "The Bit City",
    category: "game",
    hosts: [
      { host: "https://TheBitCity.io/play", registrableDomain: true },
      { host: "app.thebitcity.io", primary: true },
    ],
    contracts: [{ address: "0x072D4706f9A383D5608BD14B09b41683cb95fFd7", role: "router" }, { address: "" }],
  });
  assert.equal(v.ok, true);
  assert.equal(v.app.slug, "the-bit-city");
  assert.deepEqual(v.app.hosts, [
    { host: "thebitcity.io", registrableDomain: true, primary: false },
    { host: "app.thebitcity.io", registrableDomain: false, primary: true },
  ]);
  assert.deepEqual(v.app.contracts, [{ address: "0x072d4706f9a383d5608bd14b09b41683cb95ffd7", role: "router" }]);
});

test("refused: shared hosting covering subdomains, a subdomain covering subdomains, bad hosts and addresses", () => {
  const bad = (hosts, contracts = []) => validateAppInput({ name: "X", hosts, contracts });
  assert.match(bad([{ host: "myapp.vercel.app", registrableDomain: true }]).errors.join(), /shared hosting/);
  assert.equal(validateAppInput({ name: "X", hosts: [{ host: "myapp.vercel.app" }] }).ok, true); // exact host is fine
  assert.match(bad([{ host: "app.example.com", registrableDomain: true }]).errors.join(), /only a whole domain like example\.com/);
  assert.match(bad([{ host: "localhost" }]).errors.join(), /isn't a public website host/);
  assert.match(bad([{ host: "10.0.0.1" }]).errors.join(), /isn't a public website host/);
  assert.match(bad([]).errors.join(), /at least one website/);
  assert.match(bad([{ host: "ok.com" }], [{ address: "0x123" }]).errors.join(), /isn't a valid contract address/);
  assert.match(validateAppInput({ name: "", hosts: [{ host: "ok.com" }] }).errors.join(), /Name is required/);
});

test("a host already listed for another app is a conflict; the same app may keep its own", () => {
  const existing = [{ slug: "electroswap", name: "ElectroSwap", hosts: [{ host: "electroswap.io" }] }];
  assert.deepEqual(hostConflicts({ slug: "fake", hosts: [{ host: "electroswap.io" }] }, existing), ["electroswap.io is already listed for ElectroSwap."]);
  assert.deepEqual(hostConflicts({ slug: "electroswap", hosts: [{ host: "electroswap.io" }] }, existing), []);
  assert.equal(slugify("  Rarible!! "), "rarible");
});

test("registry admins: the Argus admin, planetzephyros.etn and mav-browney.electroswap.etn — by address", () => {
  assert.ok(REGISTRY_ADMINS.has("0xa48bc549a329eed01e491c7cd950857a8ae56e73"));
  assert.ok(REGISTRY_ADMINS.has("0x3fd2e5b4ac0eff6dfdf2446abddab3f66b425099"));
  assert.ok(REGISTRY_ADMINS.has("0x696a7b9ea5c86da15d569d99d75ed788cce4db2e"));
  assert.equal(REGISTRY_ADMINS.size, 3);
});
