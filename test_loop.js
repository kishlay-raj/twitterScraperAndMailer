const fs = require('fs');

// We'll mock chrome and fetch
global.chrome = {
  storage: {
    local: {
      get: async () => ({
        settings: { llmApiKey: 'mock-llm', emailApiKey: 'mock-webhook', recipientEmail: 'mock@a.com' }
      }),
      set: async () => {}
    }
  }
};

global.fetch = async (url) => {
  console.log("FETCH CALLED:", url);
  return { ok: true, json: async () => ({ status: 'success', choices: [{message:{content:'Mock summary'}}] }) };
};

eval(fs.readFileSync('background/email_api.js', 'utf8'));
eval(fs.readFileSync('background/llm_api.js', 'utf8'));
eval(fs.readFileSync('background/service_worker.js', 'utf8').replace("importScripts('llm_api.js', 'email_api.js');", ""));

async function run() {
  const payload = {
    "TestCategory": {
      extraEmails: "",
      profiles: [
        { url: "https://x.com/A", profileMeta: {}, enableAiSummary: false, scrapeRetweets: true, tweets: [] }
      ]
    }
  };
  await processAndDispatch(payload);
  console.log("DONE!");
}
run();
