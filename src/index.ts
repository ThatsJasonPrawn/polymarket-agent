import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

// Simple in-memory cache
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 60000; // 1 minute

function getCached(key: string) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCache(key: string, data: any) {
  cache.set(key, { data, timestamp: Date.now() });
}

// Helper to calculate bid-ask spread
function calculateSpread(outcomePrices: string): number | null {
  try {
    const prices = JSON.parse(outcomePrices);
    if (prices.length >= 2) {
      const yes = parseFloat(prices[0]);
      const no = parseFloat(prices[1]); 
      return Math.abs(yes + no - 1); // Spread = deviation from 100%
    }
  } catch (e) {}
  return null;
}

const POLYMARKET_API = 'https://gamma-api.polymarket.com';

const agent = await createAgent({
  name: 'polymarket-agent',
  version: '1.0.0',
  description: 'Real-time Polymarket prediction market data — prices, volumes, trending markets, and more.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// Agent manifest endpoint
app.get('/.well-known/agent.json', (c) => {
  return c.json({
    name: 'polymarket-agent',
    version: '1.0.0',
    description: 'Real-time Polymarket prediction market data — prices, volumes, trending markets, and more.',
    author: 'Jason Prawn',
    endpoints: {
      health: { price: 0, description: 'Health check (FREE)' },
      trending: { price: 1000, description: 'Top markets by volume ($0.001)' },
      market: { price: 1000, description: 'Market details by slug ($0.001)' },
      search: { price: 2000, description: 'Search markets by keyword ($0.002)' },
      categories: { price: 500, description: 'List all categories ($0.0005)' },
      category: { price: 1000, description: 'Markets by category ($0.001)' },
      liquidity: { price: 1500, description: 'High-liquidity markets ($0.0015)' },
    },
    categories: ['crypto', 'politics', 'sports', 'pop culture', 'science', 'business'],
    x402: true,
    created: '2026-02-01',
  });
});

// ============ FREE ENDPOINT ============

addEntrypoint({
  key: 'health',
  description: 'Health check and API status (FREE)',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const res = await fetch(`${POLYMARKET_API}/markets?limit=1`);
    const ok = res.ok;
    return {
      output: {
        status: ok ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        source: 'polymarket',
        version: '1.0.0',
      },
    };
  },
});

// ============ PAID ENDPOINTS ============

// 1. Get trending markets by volume
addEntrypoint({
  key: 'trending',
  description: 'Get top trending prediction markets by 24h volume',
  input: z.object({
    limit: z.number().min(1).max(20).default(10),
  }),
  price: { amount: 1000 }, // $0.001
  handler: async ({ input }) => {
    const cacheKey = `trending-${input.limit}`;
    const cached = getCached(cacheKey);
    if (cached) return { output: cached };

    const res = await fetch(
      `${POLYMARKET_API}/markets?active=true&closed=false&limit=${input.limit}&order=volume24hr&ascending=false`
    );
    const data = await res.json();
    
    const markets = data.map((m: any) => ({
      id: m.id,
      question: m.question,
      slug: m.slug,
      probability: parseFloat(m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : '0'),
      volume24h: m.volume24hr || 0,
      volumeTotal: m.volumeNum || 0,
      liquidity: m.liquidityNum || 0,
      endDate: m.endDate,
      category: m.category,
      spread: calculateSpread(m.outcomePrices || '[]'),
    }));

    const result = { markets, count: markets.length, fetchedAt: new Date().toISOString() };
    setCache(cacheKey, result);
    return { output: result };
  },
});

// New: List available categories
addEntrypoint({
  key: 'categories',
  description: 'Get list of all available market categories',
  input: z.object({}),
  price: { amount: 500 }, // $0.0005
  handler: async () => {
    const cacheKey = 'categories-list';
    const cached = getCached(cacheKey);
    if (cached) return { output: cached };

    const res = await fetch(`${POLYMARKET_API}/markets?active=true&closed=false&limit=200`);
    const data = await res.json();
    
    const categories = [...new Set(data.map((m: any) => m.category).filter(Boolean))]
      .sort()
      .map(cat => ({
        name: cat,
        count: data.filter((m: any) => m.category === cat).length
      }));

    const result = { categories, totalCategories: categories.length };
    setCache(cacheKey, result);
    return { output: result };
  },
});

// 2. Get market details by slug
addEntrypoint({
  key: 'market',
  description: 'Get detailed market data by slug',
  input: z.object({
    slug: z.string(),
  }),
  price: { amount: 1000 }, // $0.001
  handler: async ({ input }) => {
    const cacheKey = `market-${input.slug}`;
    const cached = getCached(cacheKey);
    if (cached) return { output: cached };

    const res = await fetch(`${POLYMARKET_API}/markets?slug=${encodeURIComponent(input.slug)}`);
    const data = await res.json();
    
    if (!data || data.length === 0) {
      return { output: { error: 'Market not found', slug: input.slug } };
    }

    const m = data[0];
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');

    const result = {
      id: m.id,
      question: m.question,
      description: m.description,
      slug: m.slug,
      outcomes: outcomes.map((o: string, i: number) => ({
        name: o,
        probability: parseFloat(prices[i] || '0'),
      })),
      volume24h: m.volume24hr || 0,
      volumeTotal: m.volumeNum || 0,
      liquidity: m.liquidityNum || 0,
      endDate: m.endDate,
      category: m.category,
      active: m.active,
      closed: m.closed,
      spread: calculateSpread(m.outcomePrices || '[]'),
      fetchedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result);
    return { output: result };
  },
});

// 3. Search markets
addEntrypoint({
  key: 'search',
  description: 'Search prediction markets by keyword',
  input: z.object({
    query: z.string(),
    limit: z.number().min(1).max(50).default(10),
  }),
  price: { amount: 2000 }, // $0.002 (more expensive - search is compute heavy)
  handler: async ({ input }) => {
    const cacheKey = `search-${input.query}-${input.limit}`;
    const cached = getCached(cacheKey);
    if (cached) return { output: cached };

    const res = await fetch(
      `${POLYMARKET_API}/markets?active=true&closed=false&limit=150` // Increased for better search results
    );
    const data = await res.json();
    
    const query = input.query.toLowerCase();
    const matches = data
      .filter((m: any) => 
        m.question?.toLowerCase().includes(query) ||
        m.description?.toLowerCase().includes(query) ||
        m.category?.toLowerCase().includes(query)
      )
      .slice(0, input.limit)
      .map((m: any) => ({
        id: m.id,
        question: m.question,
        slug: m.slug,
        probability: parseFloat(m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : '0'),
        volume24h: m.volume24hr || 0,
        category: m.category,
        spread: calculateSpread(m.outcomePrices || '[]'),
      }));

    const result = { query: input.query, markets: matches, count: matches.length };
    setCache(cacheKey, result);
    return { output: result };
  },
});

// 4. Get markets by category  
addEntrypoint({
  key: 'category',
  description: 'Get markets filtered by category (crypto, politics, sports, etc.)',
  input: z.object({
    category: z.string(),
    limit: z.number().min(1).max(20).default(10),
  }),
  price: { amount: 1000 }, // $0.001
  handler: async ({ input }) => {
    const cacheKey = `category-${input.category}-${input.limit}`;
    const cached = getCached(cacheKey);
    if (cached) return { output: cached };

    const res = await fetch(
      `${POLYMARKET_API}/markets?active=true&closed=false&limit=200` // Fetch more to increase chances of matches
    );
    const data = await res.json();
    
    const categoryLower = input.category.toLowerCase();
    
    // Enhanced category matching - check category, question, and tags
    const matches = data
      .filter((m: any) => {
        const cat = (m.category || '').toLowerCase();
        const question = (m.question || '').toLowerCase();
        const tags = (m.tags || []).map((t: string) => t.toLowerCase());
        
        return cat.includes(categoryLower) || 
               question.includes(categoryLower) ||
               tags.some((tag: string) => tag.includes(categoryLower)) ||
               // Common category mappings
               (categoryLower === 'crypto' && (cat.includes('cryptocurrency') || question.includes('bitcoin') || question.includes('crypto'))) ||
               (categoryLower === 'politics' && (cat.includes('political') || cat.includes('election'))) ||
               (categoryLower === 'sports' && (cat.includes('sport') || question.includes('super bowl')));
      })
      .slice(0, input.limit)
      .map((m: any) => ({
        id: m.id,
        question: m.question,
        slug: m.slug,
        probability: parseFloat(m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : '0'),
        volume24h: m.volume24hr || 0,
        volumeTotal: m.volumeNum || 0,
        category: m.category,
        spread: calculateSpread(m.outcomePrices || '[]'),
      }));

    const result = { 
      category: input.category, 
      markets: matches, 
      count: matches.length,
      // Debug info for fixing
      availableCategories: [...new Set(data.map((m: any) => m.category).filter(Boolean))].slice(0, 10)
    };
    
    setCache(cacheKey, result);
    return { output: result };
  },
});

// 5. Get high-liquidity markets (for agents that want to trade)
addEntrypoint({
  key: 'liquidity',
  description: 'Get markets with highest liquidity (best for trading)',
  input: z.object({
    minLiquidity: z.number().default(10000),
    limit: z.number().min(1).max(20).default(10),
  }),
  price: { amount: 1500 }, // $0.0015
  handler: async ({ input }) => {
    const res = await fetch(
      `${POLYMARKET_API}/markets?active=true&closed=false&limit=100`
    );
    const data = await res.json();
    
    const highLiquidity = data
      .filter((m: any) => (m.liquidityNum || 0) >= input.minLiquidity)
      .sort((a: any, b: any) => (b.liquidityNum || 0) - (a.liquidityNum || 0))
      .slice(0, input.limit)
      .map((m: any) => ({
        id: m.id,
        question: m.question,
        slug: m.slug,
        probability: parseFloat(m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : '0'),
        liquidity: m.liquidityNum || 0,
        volume24h: m.volume24hr || 0,
        spread: m.spread || null,
      }));

    return { output: { minLiquidity: input.minLiquidity, markets: highLiquidity, count: highLiquidity.length } };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🎰 Polymarket Agent v1.0.1 running on port ${port}`);

export default { port, fetch: app.fetch };
