declare module "3dmol" {
  export function createViewer(
    element: HTMLElement,
    config?: Record<string, unknown>,
  ): {
    addModel(data: string, format: string): void;
    setStyle(sel: Record<string, unknown>, style: Record<string, unknown>): void;
    zoomTo(): void;
    render(): void;
    resize(): void;
    clear(): void;
  };
}
