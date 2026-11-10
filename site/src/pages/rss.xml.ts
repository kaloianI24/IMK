import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context: any) {
  const posts = await getCollection('blog');
  posts.sort((a, b) => new Date(b.data.publishedAt).getTime() - new Date(a.data.publishedAt).getTime());
  return rss({
    title: 'IMK Blog',
    description: 'Automation tips, case studies, and practical guides for teams looking to save hours every week.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: new Date(post.data.publishedAt),
      description: post.data.description,
      link: `/blog/${post.id.replace('.md', '')}/`,
    })),
    customData: '<language>en-gb</language>',
  });
}