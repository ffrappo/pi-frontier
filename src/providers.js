// providers.js — classification of every models.dev provider id.
//  creator    — first-party model makers (each has its own provider id)
//  cloud      — hyperscaler / enterprise cloud gateways hosting others' models
//  aggregator — inference resellers / routers / marketplaces (default)
//
// models.dev keys the catalog by provider id, and every real model maker has
// its own first-party entry — so the creator set is the source of truth for
// "who actually built this model".

const CREATOR = new Set([
  'openai',
  'anthropic',
  'google',                    // includes first-party Gemma open weights
  'xai',
  'mistral',
  'deepseek',
  'alibaba',                   // Qwen (alibaba-cn is a polluted gateway → aggregator)
  'moonshotai', 'moonshotai-cn', // Kimi
  'cohere',
  'minimax', 'minimax-cn',
  'zai', 'zhipuai',            // GLM
  'llama',                     // Meta Llama
  'perplexity',                // Sonar
  'stepfun',
  'xiaomi',                    // MiMo
  'inception',                 // Mercury
  'sarvam',
  'morph',
  'upstage',                   // Solar
]);

const CLOUD = new Set([
  'amazon-bedrock',
  'azure', 'azure-cognitive-services',
  'google-vertex', 'google-vertex-anthropic',
  'databricks',
  'sap-ai-core',
  'github-copilot', 'github-models', 'gitlab',
  'cloudflare-workers-ai', 'cloudflare-ai-gateway',
  'digitalocean',
  'ovhcloud', 'scaleway', 'vultr', 'nebius',
  'vercel', 'v0',
]);

// Everything else — openrouter, togetherai, fireworks-ai, deepinfra, groq,
// cerebras, nvidia, baseten, venice, novita-ai, requesty, poe, nano-gpt,
// llmgateway, the coding-plan resellers, etc. → aggregator.

export function classifyProvider(p) {
  if (CREATOR.has(p)) return 'creator';
  if (CLOUD.has(p)) return 'cloud';
  return 'aggregator';
}
