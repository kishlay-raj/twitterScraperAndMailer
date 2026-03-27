const fs = require('fs');

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
  return { ok: true, json: async () => ({ status: 'success', choices: [{message:{content:'Mock summary'}}] }) };
};

// Mock dependencies
global.summarizeTweets = async () => "mock summary";
global.sendEmailPayload = async (html, to) => console.log("Sent email to", to);

const code = fs.readFileSync('background/service_worker.js', 'utf8');
// Extract just processAndDispatch
const match = code.match(/async function processAndDispatch[\s\S]*?^}/m);
if (match) {
    eval(match[0]);
    const payload = {
      "Category1": {
        extraEmails: "",
        profiles: [
          { url: "https://x.com/A", profileMeta: {}, enableAiSummary: false, scrapeRetweets: true, tweets: [{ id: "1", text: "t1" }] }
        ]
      }
    };
    processAndDispatch(payload).then(() => console.log("SUCCESS")).catch(e => console.error("ERROR", e));
} else {
    console.log("Could not extract function");
}
