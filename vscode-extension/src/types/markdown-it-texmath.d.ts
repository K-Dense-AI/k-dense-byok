declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";

  interface TexMathEngine {
    renderToString(expression: string, options?: Record<string, unknown>): string;
  }

  interface TexMathOptions {
    engine: TexMathEngine;
    delimiters?: string;
    katexOptions?: Record<string, unknown>;
  }

  const texmath: (md: MarkdownIt, options: TexMathOptions) => void;

  export default texmath;
}
