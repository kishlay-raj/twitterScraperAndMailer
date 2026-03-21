const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const dom = new JSDOM(`
  <div data-testid="tweet">
    <!-- Main Author -->
    <div data-testid="User-Name"><span>MainUser</span> <span>@mainuser</span></div>
    <a href="/mainuser/status/123456">Link</a>
    <div data-testid="tweetText">This is the main tweet!</div>

    <!-- Quote Box -->
    <div role="link">
      <div data-testid="User-Name"><span>QuotedUser</span> <span>@quoteduser</span></div>
      <div data-testid="tweetText">This is the quoted tweet!</div>
      <div data-testid="tweetPhoto"><img src="http://example.com/quoted.jpg"></div>
    </div>
  </div>
`);
const document = dom.window.document;
const Node = dom.window.Node;

const tweetEl = document.querySelector('[data-testid="tweet"]');
const userNames = Array.from(tweetEl.querySelectorAll('[data-testid="User-Name"]'));
const qNameEl = userNames.length > 1 ? userNames[1] : null;

let text = '';
let qText = '';
const allTexts = Array.from(tweetEl.querySelectorAll('[data-testid="tweetText"]'));
for (const txtEl of allTexts) {
    if (qNameEl && (qNameEl.compareDocumentPosition(txtEl) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        qText = (txtEl.textContent).trim();
    } else {
        text = (txtEl.textContent).trim();
    }
}

const mediaUrls = [];
const qMediaUrls = [];
const allMedia = Array.from(tweetEl.querySelectorAll('[data-testid="tweetPhoto"] img, video'));
for (const media of allMedia) {
    if (qNameEl && (qNameEl.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        if (media.src) qMediaUrls.push(media.src);
    } else {
        if (media.src) mediaUrls.push(media.src);
    }
}

console.log({ text, qText, mediaUrls, qMediaUrls });
