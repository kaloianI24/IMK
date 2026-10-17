import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { CTA_ROLES } from './types/contracts.js';

const ctaSchema = z.enum([...CTA_ROLES]);

const howStep = z.object({ title: z.string().min(1).max(80), body: z.string().min(1).max(400) });
const faqItem = z.object({ q: z.string().min(1).max(240), a: z.string().min(1).max(1200) });

const services = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/services' }),
  schema: z.object({
    order: z.number().int().min(1).max(4),
    title: z.string().min(1).max(60),
    tagline: z.string().min(1).max(140),
    summary: z.string().min(1).max(260),
    whoFor: z.string().min(1).max(400),
    problem: z.string().min(1).max(600),
    deliverables: z.array(z.string().min(1).max(200)).min(3).max(8),
    howItWorks: z.array(howStep).min(3).max(5),
    inScope: z.array(z.string().min(1).max(200)).min(1).max(12),
    outOfScope: z.array(z.string().min(1).max(200)).min(1).max(12),
    timeline: z.string().min(1).max(120),
    startingAt: z.string().min(1).max(120),
    careOption: z.string().min(1).max(200),
    faq: z.array(faqItem).min(1).max(5),
    caseSnapshot: z.string().min(1).max(240),
    cta: ctaSchema,
  }),
});

const cases = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/cases' }),
  schema: z.object({
    order: z.number().int().min(1).max(3).optional(),
    title: z.string().min(1).max(80),
    sector: z.string().min(1).max(60),
    sample: z.literal(true),
    context: z.string().min(1).max(600),
    problem: z.string().min(1).max(600),
    approach: z.string().min(1).max(800),
    execution: z.array(z.string().min(1).max(300)).min(3).max(8),
    outcome: z.string().min(1).max(240),
    result: z.string().min(1).max(800),
    quote: z.object({ quote: z.string().min(1).max(600), name: z.string().min(1).max(80), role: z.string().min(1).max(120) }).optional(),
    cta: ctaSchema,
  }),
});

export const collections = { services, cases };