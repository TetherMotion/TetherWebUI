import { RecipeInfoView } from '../domain/machine-control';

function esc(text: string): string {
  const element = document.createElement('span');
  element.textContent = text;
  return element.innerHTML;
}

export interface RecipesModel {
  available: boolean;
  recipes?: RecipeInfoView[];
  /** Last apply outcome line (transaction id + state). */
  result?: string;
  busy: boolean;
}

export function renderRecipes(root: HTMLElement, model: RecipesModel): void {
  const panel = root.querySelector<HTMLElement>('#recipes-panel');
  if (!panel) return;
  if (!model.available) {
    panel.innerHTML =
      '<p class="widget-empty">No recipe store attached — the optional machine.recipe.* surface is absent.</p>';
    return;
  }
  const cards = (model.recipes ?? [])
    .map(
      (recipe) => `<article class="recipe-card machine-card">
        <div class="panel-title"><div><h3>${esc(recipe.name)}</h3><p class="recipe-desc">${esc(recipe.description)}</p></div><span class="badge">${recipe.entryCount} params</span></div>
        <button type="button" class="recipe-apply" data-recipe="${esc(recipe.name)}" ${model.busy ? 'disabled' : ''}>Stage recipe</button>
      </article>`,
    )
    .join('');
  panel.innerHTML = `
    <p class="event-history-note">Applying a recipe <em>stages</em> a configuration transaction — validate and commit it on the Commissioning page before anything is written. Apply calls are audited.</p>
    <div class="recipe-grid">${cards || '<p class="widget-empty">The recipe store is empty.</p>'}</div>
    <button type="button" id="recipes-refresh" class="secondary" ${model.busy ? 'disabled' : ''}>Refresh list</button>
    <p class="form-result" role="status">${esc(model.result ?? (model.recipes ? '' : 'Load the recipe list to begin.'))}</p>`;
}
