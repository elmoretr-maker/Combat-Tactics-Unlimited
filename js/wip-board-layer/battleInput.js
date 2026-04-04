/**
 * Maps pointer events to grid coordinates using the same layout as the render pass
 * (centered grid offsets + cell size).
 */
export class BattleInputHandler {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => object | null} getGame
   * @param {() => { gridOffsetX: number, gridOffsetY: number, cellSize: number }} getGridLayout
   * @param {{ onCellClick?: (cell: {x:number,y:number}, ev: Event) => void, onCellHover?: (cell: {x:number,y:number} | null, ev: Event) => void }} handlers
   */
  constructor(canvas, getGame, getGridLayout, handlers) {
    this.canvas = canvas;
    this.getGame = getGame;
    this.getGridLayout = getGridLayout;
    this.handlers = handlers;
    this._click = (e) => this._onClick(e);
    this._move = (e) => this._onMove(e);
    canvas.addEventListener("click", this._click);
    canvas.addEventListener("mousemove", this._move);
  }

  destroy() {
    this.canvas.removeEventListener("click", this._click);
    this.canvas.removeEventListener("mousemove", this._move);
  }

  /** Integer grid cell from client coordinates; not clamped to bounds. */
  gridCellFromClient(clientX, clientY) {
    const game = this.getGame();
    if (!game?.grid) return null;
    const rect = this.canvas.getBoundingClientRect();
    const sx = (clientX - rect.left) * (this.canvas.width / rect.width);
    const sy = (clientY - rect.top) * (this.canvas.height / rect.height);
    const { gridOffsetX, gridOffsetY, cellSize } = this.getGridLayout();
    return {
      x: Math.floor((sx - gridOffsetX) / cellSize),
      y: Math.floor((sy - gridOffsetY) / cellSize),
    };
  }

  _onClick(ev) {
    const c = this.gridCellFromClient(ev.clientX, ev.clientY);
    if (c) this.handlers.onCellClick?.(c, ev);
  }

  _onMove(ev) {
    const c = this.gridCellFromClient(ev.clientX, ev.clientY);
    this.handlers.onCellHover?.(c, ev);
  }
}
