#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const TOPICS_FILE = path.join(ROOT, 'data', 'topics.json');

// API keys from env
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY_1 || process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!CLAUDE_API_KEY) {
  console.error('ERROR: No Claude API key found. Set CLAUDE_API_KEY_1 or ANTHROPIC_API_KEY.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

// ---- Gemini Nanobanana image generation (primary) ----
async function fetchGeminiImage(query) {
  if (!GEMINI_API_KEY) {
    console.log('No GEMINI_API_KEY set, skipping Gemini image generation.');
    return null;
  }
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Create a stunning, high-quality landscape photograph of ${query}. Style: professional nature photography, dramatic golden hour lighting, vivid colors, wide angle, 16:9 composition. No text or watermarks.`
          }]
        }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"]
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.log(`Gemini API error: ${res.status} - ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts) {
      console.log('Gemini: no parts in response');
      return null;
    }

    for (const part of parts) {
      if (part.inlineData) {
        const buffer = Buffer.from(part.inlineData.data, 'base64');
        return {
          buffer,
          alt: query,
          credit: 'Generated with Gemini'
        };
      }
    }
    console.log('Gemini: no image in response');
    return null;
  } catch (err) {
    console.log('Gemini image generation failed:', err.message);
    return null;
  }
}

// ---- Unsplash image fetch (fallback 1) ----
async function fetchUnsplashImage(query) {
  if (!UNSPLASH_ACCESS_KEY) {
    console.log('No UNSPLASH_ACCESS_KEY set, skipping Unsplash.');
    return null;
  }
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=1&content_filter=high`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` }
    });
    if (!res.ok) {
      console.log(`Unsplash API error: ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;
    const photo = data.results[0];
    const imgUrl = photo.urls.regular;
    const imgRes = await fetch(imgUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return {
      buffer,
      alt: photo.alt_description || photo.description || query,
      credit: `Photo by [${photo.user.name}](${photo.user.links.html}) on [Unsplash](https://unsplash.com)`
    };
  } catch (err) {
    console.log('Unsplash fetch failed:', err.message);
    return null;
  }
}

// ---- OpenAI image fallback (fallback 2) ----
async function fetchOpenAIImage(query) {
  if (!OPENAI_API_KEY) {
    console.log('No OPENAI_API_KEY set, skipping OpenAI image generation.');
    return null;
  }
  try {
    const OpenAI = require('openai');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: `Beautiful landscape photograph of ${query}, dramatic lighting, professional nature photography, 16:9 aspect ratio`,
      n: 1,
      size: '1792x1024',
      quality: 'standard'
    });
    const imgUrl = response.data[0].url;
    const imgRes = await fetch(imgUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return {
      buffer,
      alt: query,
      credit: 'AI-generated image'
    };
  } catch (err) {
    console.log('OpenAI image generation failed:', err.message);
    return null;
  }
}

// ---- Get hero image: Gemini -> Unsplash -> OpenAI ----
async function getHeroImage(query) {
  let img = await fetchGeminiImage(query);
  if (!img) img = await fetchUnsplashImage(query);
  if (!img) img = await fetchOpenAIImage(query);
  return img;
}

// ---- Convert to WebP ----
async function toWebP(buffer) {
  return sharp(buffer)
    .resize(1200, 675, { fit: 'cover' })
    .webp({ quality: 82 })
    .toBuffer();
}

// ---- Generate article with Claude ----
async function generateArticle(topic, allTopics) {
  const relatedLinks = (topic.relatedSlugs || [])
    .map(slug => {
      const related = allTopics.find(t => t.slug === slug);
      if (!related) return null;
      const section = related.category;
      return `[${related.title}](/${section}/${related.slug}/)`;
    })
    .filter(Boolean);

  const systemPrompt = `You are an expert outdoor and hiking writer for Trail Tales, a premium hiking blog. Write authoritative, engaging content that demonstrates genuine trail knowledge (E-E-A-T).

STYLE RULES:
- Write in a confident, knowledgeable tone -- like a seasoned hiker sharing advice with a friend
- Use specific details: trail names, distances in km/miles, elevation in meters/feet, specific gear brands when relevant
- Include practical logistics: costs, permits, best seasons, how to get there
- NO filler phrases: never use "in this guide", "let's dive in", "without further ado", "in conclusion", "whether you're a beginner or expert"
- NO generic intros -- start with something specific and engaging about the trail/topic
- Use short paragraphs (2-4 sentences max)
- Include a compelling hook in the first paragraph

STRUCTURE:
- 1400-1800 words
- Use question-based H2 headings (## ) for SEO -- at least 4 H2s
- Include a FAQ section at the end with exactly 4 Q&As using this format:
  ## Frequently Asked Questions
  Then each Q&A as:
  ### Q: [question]?
  [answer in 2-3 sentences]
- Naturally mention and link to these related articles where relevant: ${relatedLinks.join(', ') || 'none available yet'}

CONTENT FOCUS for "${topic.title}":
Key points to cover: ${topic.keyPoints.join(', ')}
Target keywords: ${topic.keywords.join(', ')}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `Write a comprehensive hiking article titled "${topic.title}". Follow the style rules exactly. Output ONLY the article body in markdown (no front matter, no title H1).`
    }],
    system: systemPrompt
  });

  return response.content[0].text;
}

// ---- Extract FAQ from article for schema ----
function extractFAQ(markdown) {
  const faqs = [];
  const qRegex = /###\s*Q:\s*(.+)\?\s*\n+([\s\S]*?)(?=###\s*Q:|$)/g;
  let match;
  while ((match = qRegex.exec(markdown)) !== null) {
    faqs.push({
      question: match[1].trim() + '?',
      answer: match[2].trim().replace(/\n+/g, ' ')
    });
  }
  return faqs;
}

// ---- Build front matter ----
function buildFrontMatter(topic, faq, imageCredit) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const description = `${topic.title.replace(/:/g, ' --')} Complete guide with routes, tips, and practical advice for planning your trek.`;
  const truncDesc = description.length > 155 ? description.substring(0, 152) + '...' : description;
  const truncTitle = topic.title.length > 60 ? topic.title.substring(0, 57) + '...' : topic.title;

  let yaml = '---\n';
  yaml += `title: ${JSON.stringify(truncTitle)}\n`;
  yaml += `date: ${dateStr}\n`;
  yaml += `draft: false\n`;
  yaml += `description: ${JSON.stringify(truncDesc)}\n`;
  yaml += `tags:\n${topic.tags.map(t => `  - "${t}"`).join('\n')}\n`;
  const catName = topic.category === 'trail-guides' ? 'Trail Guides' : topic.category === 'gear-reviews' ? 'Gear Reviews' : 'How-To';
  yaml += `categories:\n  - "${catName}"\n`;
  if (topic.tags.includes('multi-day')) {
    yaml += `series:\n  - "Multi-Day Treks"\n`;
  } else if (topic.tags.includes('gear')) {
    yaml += `series:\n  - "Gear Guide"\n`;
  }
  yaml += `showTableOfContents: true\n`;
  yaml += `showHero: true\n`;
  yaml += `heroStyle: "big"\n`;

  if (faq.length > 0) {
    yaml += `faq:\n`;
    faq.forEach(f => {
      yaml += `  - question: ${JSON.stringify(f.question)}\n`;
      yaml += `    answer: ${JSON.stringify(f.answer)}\n`;
    });
  }

  yaml += '---\n';
  return yaml;
}

// ---- Main ----
async function main() {
  const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));

  const topic = topics.find(t => !t.published);
  if (!topic) {
    console.log('All topics have been published!');
    process.exit(0);
  }

  console.log(`Generating article: ${topic.title}`);
  console.log(`Category: ${topic.category} | Slug: ${topic.slug}`);

  console.log('Calling Claude API...');
  const articleBody = await generateArticle(topic, topics);
  console.log(`Article generated: ~${articleBody.split(/\s+/).length} words`);

  const faq = extractFAQ(articleBody);
  console.log(`Extracted ${faq.length} FAQ items`);

  console.log(`Fetching image: "${topic.imageQuery}"`);
  const img = await getHeroImage(topic.imageQuery);

  const postDir = path.join(ROOT, 'content', topic.category, topic.slug);
  fs.mkdirSync(postDir, { recursive: true });

  let imageCredit = '';
  if (img) {
    const webpBuffer = await toWebP(img.buffer);
    fs.writeFileSync(path.join(postDir, 'featured.webp'), webpBuffer);
    imageCredit = img.credit;
    console.log('Hero image saved as featured.webp');
  } else {
    console.log('No image available -- article will have no hero image');
  }

  const frontMatter = buildFrontMatter(topic, faq, imageCredit);
  let fullContent = frontMatter + '\n' + articleBody;

  if (imageCredit) {
    fullContent += `\n\n---\n\n*Hero image: ${imageCredit}*\n`;
  }

  fs.writeFileSync(path.join(postDir, 'index.md'), fullContent);
  console.log(`Saved: content/${topic.category}/${topic.slug}/index.md`);

  topic.published = true;
  fs.writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2) + '\n');
  console.log('Updated topics.json');

  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
