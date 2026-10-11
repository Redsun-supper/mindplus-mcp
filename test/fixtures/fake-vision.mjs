// Fake "vision model" for the test suite: proves the provider plumbing
// (argv template, prompt file, image file, JSON parsing) without an API key.
//
// Usage from the test: node fake-vision.mjs {image} --prompt {prompt}
import fs from 'node:fs';

const args = process.argv.slice(2);
const imageIndex = args.indexOf('--prompt');
const imagePath = args[0];
const promptPath = imageIndex >= 0 ? args[imageIndex + 1] : null;
const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';

const sawImage = Boolean(imagePath) && fs.existsSync(imagePath);
const report = {
  sawImage,
  imageBytes: sawImage ? fs.statSync(imagePath).size : 0,
  promptHasTarget: prompt.includes('TARGET:'),
  promptHasGoal: prompt.includes('GOAL:'),
};

if (process.env.FAKE_VISION_MODE === 'action') {
  process.stdout.write(
    `\`\`\`json\n${JSON.stringify({ action: 'click', x: 11, y: 22, reason: 'fake provider step' })}\n\`\`\``,
  );
} else if (process.env.FAKE_VISION_MODE === 'garbage') {
  process.stdout.write('I could not find that, sorry.');
} else if (prompt.includes('GOAL:')) {
  process.stdout.write(JSON.stringify({ action: 'click', x: 11, y: 22, reason: `fake provider ${JSON.stringify(report)}` }));
} else if (prompt.includes('Reply with exactly')) {
  process.stdout.write('{"ok":true}');
} else {
  process.stdout.write(
    JSON.stringify({
      found: true,
      label: 'fake target',
      x: 40,
      y: 25,
      width: 20,
      height: 10,
      confidence: 0.87,
      reasoning: `fake provider ${JSON.stringify(report)}`,
      alternatives: [{ label: 'other', x: 80, y: 50, confidence: 0.4 }],
    }),
  );
}
