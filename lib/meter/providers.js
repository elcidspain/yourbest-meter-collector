// Provider-reported measurements only. No token-to-money estimates.
export const PROVIDER_CONFIG = {
  openai: { origin: 'https://api.openai.com', keys: ['OPENAI_API_KEY'], routes: /^v1\/(?:responses|chat\/completions|embeddings|models)$/ },
  xai: { origin: 'https://api.x.ai', keys: ['XAI_API_KEY'], routes: /^v1\/(?:responses|chat\/completions|embeddings|models)$/ },
  google: { origin: 'https://generativelanguage.googleapis.com', keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], routes: /^v1(?:beta)?\/(?:models(?:\/[a-zA-Z0-9._-]+:(?:generateContent|streamGenerateContent|embedContent))?|openai\/(?:chat\/completions|embeddings|models))$/ },
  anthropic: { origin: 'https://api.anthropic.com', keys: ['ANTHROPIC_API_KEY'], routes: /^v1\/(?:messages|models)$/ },
  perplexity: { origin: 'https://api.perplexity.ai', keys: ['PERPLEXITY_API_KEY'], routes: /^(?:v1\/(?:agent|responses)|chat\/completions)$/ }
};

const integer = n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
const sumKnown = (...values) => values.every(x => x !== null) && Number.isSafeInteger(values.reduce((a,b)=>a+b,0)) ? values.reduce((a,b)=>a+b,0) : null;
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

export function configuredProviders(env = process.env) {
  return Object.entries(PROVIDER_CONFIG).filter(([,v]) => v.keys.some(key=>Boolean(env[key]))).map(([key])=>key);
}

export function providerKey(provider, env = process.env) {
  return PROVIDER_CONFIG[provider]?.keys.map(key=>env[key]).find(Boolean) || null;
}

export function extractUsage(provider, payload, previous = null) {
  if (!payload || typeof payload !== 'object') return previous;
  const body = payload.response || payload.message || payload;
  const data = body.usageMetadata || body.usage || payload.usage;
  if (!data || typeof data !== 'object') return previous;
  const old = previous?.usage || {};
  const result = { model: typeof body.model === 'string' ? body.model : previous?.model || null, usage: { ...old }, cost: previous?.cost || null };
  const assign = (key,value) => { const n=integer(value); if(n!==null) result.usage[key]=n; };
  if (provider === 'google' && body.usageMetadata) {
    assign('input_tokens', data.promptTokenCount);
    assign('cached_input_tokens', data.cachedContentTokenCount);
    assign('reasoning_tokens', data.thoughtsTokenCount);
    const candidates=integer(data.candidatesTokenCount), thoughts=integer(data.thoughtsTokenCount);
    if(candidates!==null) assign('output_tokens',sumKnown(candidates,thoughts??0));
    assign('total_tokens',data.totalTokenCount);
  } else if (provider === 'anthropic') {
    // Anthropic's base input excludes both cache creation and cache reads.
    // Preserve raw components across message_start / message_delta SSE events.
    const raw={...(previous?._anthropic||{})};
    for(const key of ['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens']) if(integer(data[key])!==null) raw[key]=data[key];
    result._anthropic=raw;
    if(integer(raw.input_tokens)!==null) assign('input_tokens',sumKnown(raw.input_tokens,raw.cache_read_input_tokens??0,raw.cache_creation_input_tokens??0));
    assign('cached_input_tokens',raw.cache_read_input_tokens);
    assign('cache_creation_input_tokens',raw.cache_creation_input_tokens);
    assign('output_tokens',raw.output_tokens);
    const total=sumKnown(integer(result.usage.input_tokens),integer(result.usage.output_tokens));
    if(total!==null) assign('total_tokens',total);
  } else {
    assign('input_tokens', data.input_tokens ?? data.prompt_tokens);
    assign('output_tokens', data.output_tokens ?? data.completion_tokens);
    assign('total_tokens',data.total_tokens);
    assign('cached_input_tokens',data.input_tokens_details?.cached_tokens ?? data.input_tokens_details?.cache_read_input_tokens ?? data.prompt_tokens_details?.cached_tokens);
    assign('cache_creation_input_tokens',data.input_tokens_details?.cache_creation_input_tokens);
    assign('reasoning_tokens',data.output_tokens_details?.reasoning_tokens ?? data.completion_tokens_details?.reasoning_tokens);
    assign('search_queries',data.num_search_queries ?? data.search_queries);
    if(provider==='perplexity' && result.usage.search_queries===undefined && data.tool_calls_details && typeof data.tool_calls_details==='object') {
      const searches=Object.entries(data.tool_calls_details).filter(([key])=>/search/i.test(key)).map(([,value])=>integer(value?.invocation ?? value));
      if(searches.length && searches.every(x=>x!==null)) assign('search_queries',searches.reduce((a,b)=>a+b,0));
    }
    // xAI Chat Completions can report reasoning outside completion_tokens.
    // Keep the exact provider total; never force it to equal two components.
    if(result.usage.total_tokens===undefined) {
      const i=integer(result.usage.input_tokens),o=integer(result.usage.output_tokens);
      if(i!==null&&o!==null&&!(provider==='xai'&&data.prompt_tokens!==undefined&&result.usage.reasoning_tokens>0)) assign('total_tokens',sumKnown(i,o));
    }
  }
  if(provider==='xai' && integer(data.cost_in_usd_ticks)!==null) result.cost={amount:data.cost_in_usd_ticks/1e10,currency:'USD',basis:'provider_response'};
  if(provider==='perplexity') {
    const amount=finite(data.cost?.total_cost ?? data.cost?.total_cost_usd);
    if(amount!==null) result.cost={amount,currency:'USD',basis:'provider_response'};
  }
  return result;
}

// SSE usage fields are cumulative. Replacing observed fields, not adding chunks,
// avoids counting repeated usage events and Gemini final counters multiple times.
export function createUsageCollector(provider) {
  let result=null, pending='', frame=[],frameBytes=0,dropping=false;
  const frameLimit=8*1024*1024;
  const accept=value=>{ result=extractUsage(provider,value,result); };
  function flush() { if(!dropping&&frame.length){const data=frame.join('\n');if(data!=='[DONE]'){try{accept(JSON.parse(data));}catch{}}}frame=[];frameBytes=0;dropping=false; }
  function line(value){if(!value){flush();return;}if(dropping||!value.startsWith('data:'))return;frameBytes+=value.length;if(frameBytes>frameLimit){dropping=true;frame=[];return;}frame.push(value.slice(5).trimStart());}
  return {
    accept,
    text(chunk) {
      pending+=chunk;
      let p;while((p=pending.indexOf('\n'))>=0){const value=pending.slice(0,p).replace(/\r$/,'');pending=pending.slice(p+1);line(value);}
      if(pending.length>frameLimit){pending='';frame=[];frameBytes=0;dropping=true;}
    },
    finish(){if(pending)line(pending);pending='';flush();return result;},
    value(){return result;}
  };
}
