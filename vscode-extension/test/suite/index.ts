import * as path from "node:path";
import * as fs from "node:fs";
import Mocha from "mocha";

export async function run() {
  const mocha = new Mocha({
    color: true,
    timeout: 20000,
    ui: "tdd",
  });

  for (const fileName of fs.readdirSync(__dirname)) {
    if (!fileName.endsWith(".test.js")) {
      continue;
    }

    mocha.addFile(path.resolve(__dirname, fileName));
  }
  mocha.addFile(path.resolve(__dirname, "./workspace-targeting.test.js"));

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} extension test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}
