/** The public repository. Source notes and the colophon link into it; paths are on `main`. */
export const REPOSITORY_URL = 'https://github.com/EtkinD/evidomo';

/** A file (and optionally a Markdown heading anchor) of the repository on `main`. */
export function repositoryFileUrl(path: string, anchor?: string): string {
  return `${REPOSITORY_URL}/blob/main/${path}${anchor === undefined ? '' : `#${anchor}`}`;
}
