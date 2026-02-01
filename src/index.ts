import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

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
    }));

    return { output: { markets, count: markets.length, fetchedAt: new Date().toISOString() } };
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
    const res = await fetch(`${POLYMARKET_API}/markets?slug=${encodeURIComponent(input.slug)}`);
    const data = await res.json();
    
    if (!data || data.length === 0) {
      return { output: { error: 'Market not found', slug: input.slug } };
    }

    const m = data[0];
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');

    return {
      output: {
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
        fetchedAt: new Date().toISOString(),
      },
    };
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
    const res = await fetch(
      `${POLYMARKET_API}/markets?active=true&closed=false&limit=100`
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
      }));

    return { output: { query: input.query, markets: matches, count: matches.length } };
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
    const res = await fetch(
      `${POLYMARKET_API}/markets?active=true&closed=false&limit=${input.limit}&order=volume24hr&ascending=false`
    );
    const data = await res.json();
    
    const categoryLower = input.category.toLowerCase();
    const matches = data
      .filter((m: any) => m.category?.toLowerCase().includes(categoryLower))
      .map((m: any) => ({
        id: m.id,
        question: m.question,
        slug: m.slug,
        probability: parseFloat(m.outcomePrices ? JSON.parse(m.outcomePrices)[0] : '0'),
        volume24h: m.volume24hr || 0,
        volumeTotal: m.volumeNum || 0,
      }));

    return { output: { category: input.category, markets: matches, count: matches.length } };
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
console.log(`🎰 Polymarket Agent running on port ${port}`);

export default { port, fetch: app.fetch };
