import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

function decodeCover(image?: string): string {
  if (!image) return defaultCover;
  if (image.startsWith('http://') || image.startsWith('https://')) {
    return image;
  }
  try {
    const decoded =
      typeof atob === 'function'
        ? atob(image)
        : typeof Buffer !== 'undefined'
          ? Buffer.from(image, 'base64').toString('utf-8')
          : image;
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
      return decoded;
    }
  } catch {
    // fallback
  }
  return defaultCover;
}

function parseDate(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

function formatNovelPath(slug: string): string {
  const clean = slug.trim();
  const omniMatch = clean.match(/^([a-zA-Z0-9]+)[-\s]+([0-9]+)$/);
  if (omniMatch) {
    return `omniportal/${omniMatch[1]}/${omniMatch[2]}`;
  }
  return `novel/${clean}`;
}

function pathToSlug(novelPath: string): string {
  let clean = decodeURIComponent(novelPath.trim());
  clean = clean.replace(/^(https?:\/\/)?([^\/]+\.)?fictionzone\.net\/?/i, '');
  clean = clean.replace(/^\/+/, '');
  clean = clean.split('?')[0].split('#')[0];
  clean = clean.replace(/\/+$/, '');
  clean = clean.replace(/^(omniportal|novel)\//i, '');

  const omniMatch = clean.match(/^([a-zA-Z0-9]+)[\/\-\s]+([0-9]+)$/);
  if (omniMatch) {
    return `${omniMatch[1]}-${omniMatch[2]}`;
  }
  return clean;
}

function isOmniportal(slug: string): boolean {
  return /^([a-zA-Z0-9]+)[-\s]+([0-9]+)$/.test(slug.trim());
}

class FictionZonePlugin implements Plugin.PluginBase {
  id = 'fictionzone';
  name = 'Fiction Zone';
  icon = 'src/en/fictionzone/icon.png';
  site = 'https://fictionzone.net';
  version = '1.0.6';

  filters = {
    sort: {
      label: 'Sort By',
      value: 'bookmark_count',
      options: [
        { label: 'Most Bookmarked', value: 'bookmark_count' },
        { label: 'Latest', value: 'created_at' },
        { label: 'Rating', value: 'rating' },
        { label: 'Views', value: 'views_all' },
        { label: 'Chapter Count', value: 'chapter_count' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      label: 'Status',
      value: 'all',
      options: [
        { label: 'All', value: 'all' },
        { label: 'Ongoing', value: '1' },
        { label: 'Completed', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    genres: {
      label: 'Genres',
      value: [],
      options: [
        { label: 'Fan-Fiction', value: '3' },
        { label: 'Fantasy', value: '1' },
        { label: 'Romance', value: '8' },
        { label: 'Sci-Fi', value: '6' },
        { label: 'Urban', value: '2' },
        { label: 'Virtual Reality', value: '7' },
      ],
      type: FilterTypes.CheckboxGroup,
    },
  } satisfies Filters;

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      page: pageNo.toString(),
      page_size: '20',
      sort_by: showLatestNovels
        ? 'created_at'
        : filters?.sort?.value || 'bookmark_count',
      sort_order: 'desc',
      include_genres: 'true',
    });

    if (filters?.status?.value && filters.status.value !== 'all') {
      params.append('status', filters.status.value);
    }

    if (filters?.genres?.value && filters.genres.value.length > 0) {
      filters.genres.value.forEach(g => params.append('genres', g));
    }

    return await this.getPage(`/platform/browse?${params.toString()}`);
  }

  async getData<T>(url: string): Promise<Response<T>> {
    const res = await fetchApi(this.site + '/api/__api_party/fictionzone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        path: url,
        headers: [
          ['content-type', 'application/json'],
          ['x-request-time', new Date().toISOString()],
        ],
        method: 'GET',
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to fetch data from ${url}`);
    }

    const data = (await res.json()) as Response<T>;
    if (!data || !data.data) {
      throw new Error(data?.message || `Failed to fetch data from ${url}`);
    }
    return data;
  }

  async getPage(url: string): Promise<Plugin.NovelItem[]> {
    const data = await this.getData<{ novels: NovelItem[] }>(url);
    const novels = data?.data?.novels || [];

    return novels.map(n => ({
      name: n.title,
      cover: decodeCover(n.image),
      path: formatNovelPath(n.slug),
    }));
  }

  async getChapterPage(
    id: string,
    novelPath: string,
  ): Promise<Plugin.ChapterItem[]> {
    try {
      const data = await this.getData<{ chapters: ChapterItem[] }>(
        '/platform/chapter-lists?novel_id=' + id,
      );
      const chapters = data?.data?.chapters || [];

      return chapters.map((n, idx) => ({
        name: n.title || `Chapter ${n.chapter_number ?? idx + 1}`,
        number: n.chapter_number ?? idx + 1,
        date: parseDate(n.published_date),
        path: `${novelPath}/${n.chapter_id}|/platform/chapter-content?novel_id=${id}&chapter_id=${n.chapter_id}`,
      }));
    } catch {
      return [];
    }
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const novelSlug = pathToSlug(novelPath);
    const data = await this.getData<NovelDetails>(
      `/platform/novel-details?slug=${novelSlug}`,
    );
    const novel = data.data;

    let chapters: Plugin.ChapterItem[] = [];
    const isOmni = isOmniportal(novelSlug);

    if (!isOmni) {
      chapters = await this.getChapterPage(novel.id, novelPath);
    } else {
      // For Omniportal novels, try fetching from the omniportal chapters endpoint first
      const omniMatch = novelSlug.match(/^([a-zA-Z0-9]+)[-_]([0-9]+)$/);
      if (omniMatch) {
        try {
          const chData = await this.getData<{ chapters: ChapterItem[] }>(
            `/omniportal/novels/chapters?source_id=${omniMatch[1]}&source_key=${omniMatch[2]}&translate=en&engine=google-trans`,
          );
          if (chData?.data?.chapters?.length) {
            chapters = chData.data.chapters.map((n, idx) => ({
              name: n.title || `Chapter ${n.chapter_number ?? idx + 1}`,
              number: n.chapter_number ?? idx + 1,
              date: parseDate(n.published_date),
              path: `${novelPath}/${n.chapter_id}|/omniportal/chapters/content?source_id=${omniMatch[1]}&source_key=${omniMatch[2]}&chapter_id=${n.chapter_id}&translate=en&engine=google-trans`,
            }));
          }
        } catch {
          // Fall through
        }
      }

      if (!chapters.length) {
        chapters = await this.getChapterPage(novel.id, novelPath);
      }

      // If chapter-lists returned 0 chapters (Omniportal external sources require auth),
      // generate chapters from total_chapters so LNReader can successfully load and register the novel
      if (!chapters.length) {
        const total =
          novel.total_chapters && novel.total_chapters > 0
            ? novel.total_chapters
            : 1;
        const sourceId = omniMatch ? omniMatch[1] : '';
        const sourceKey = omniMatch ? omniMatch[2] : '';
        for (let i = 1; i <= total; i++) {
          chapters.push({
            name: `Chapter ${i}`,
            number: i,
            path: `${novelPath}/${i}|/omniportal/chapters/content?source_id=${sourceId}&source_key=${sourceKey}&chapter_id=${i}&translate=en&engine=google-trans`,
          });
        }
      }
    }

    return {
      path: novelPath,
      name: novel.title,
      cover: decodeCover(novel.image),
      genres: [
        ...(novel.genres || []).map(g => g.name),
        ...(novel.tags || []).map(g => g.name),
      ]
        .filter(Boolean)
        .join(','),
      status:
        novel.status === 1
          ? NovelStatus.Ongoing
          : novel.status === 2
            ? NovelStatus.Completed
            : NovelStatus.Unknown,
      author:
        (novel.contributors || []).find(c => c.role === 'author')
          ?.display_name || '',
      summary: novel.synopsis || '',
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    let apiPath = chapterPath.includes('|')
      ? chapterPath.split('|')[1]
      : chapterPath;

    if (apiPath.startsWith('http://') || apiPath.startsWith('https://')) {
      apiPath = apiPath.replace(/^(https?:\/\/)?([^\/]+\.)?fictionzone\.net/i, '');
    }

    try {
      const data = await this.getData<{ content?: string }>(apiPath);
      const content = data?.data?.content;

      if (content) {
        return (
          '<p>' +
          content
            .split(/\r?\n+/)
            .map(p => p.trim())
            .filter(Boolean)
            .join('</p><p>') +
          '</p>'
        );
      }
    } catch (err: any) {
      if (apiPath.includes('omniportal')) {
        return (
          '<p><strong>Fiction Zone Account Required</strong></p>' +
          '<p>Omniportal novels are translated from external platforms and Fiction Zone requires signing in to read full chapters.</p>' +
          '<p>Please open this novel in the built-in LNReader WebView to sign into your Fiction Zone account.</p>' +
          `<p><small>${err?.message || 'Access Restricted'}</small></p>`
        );
      }
      throw err;
    }

    throw new Error('Chapter content is empty or locked.');
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      search: searchTerm,
      page: pageNo.toString(),
      page_size: '20',
      search_in_synopsis: 'true',
      sort_by: 'bookmark_count',
      sort_order: 'desc',
      include_genres: 'true',
    });
    return await this.getPage(`/platform/browse?${params.toString()}`);
  }

  resolveUrl = (path: string, isNovel?: boolean) => {
    let clean = path.split('|')[0].trim();
    clean = clean.replace(/^(https?:\/\/)?([^\/]+\.)?fictionzone\.net\/?/i, '');
    clean = clean.replace(/^\/+/, '');
    clean = clean.replace(
      /^omniportal\/([a-zA-Z0-9]+)[-\s]+([0-9]+)(.*)$/,
      'omniportal/$1/$2$3',
    );
    return `${this.site}/${clean}`;
  };
}

export default new FictionZonePlugin();

type Response<T> = {
  success?: boolean;
  message?: string;
  data: T;
};

type NovelItem = {
  title: string;
  image?: string;
  slug: string;
};

type ChapterItem = {
  title?: string;
  chapter_number?: number;
  published_date?: string;
  chapter_id: string;
};

type NovelDetails = {
  id: string;
  title: string;
  image?: string;
  genres?: { name: string }[];
  tags?: { name: string }[];
  status: number;
  total_chapters?: number;
  contributors?: { role: string; display_name: string }[];
  synopsis?: string;
};
