import type { GitHubIssueLabel, GitHubIssueType } from "@t3tools/contracts";
import { CheckIcon, ListFilterIcon, ShapesIcon, TagIcon, XIcon } from "lucide-react";
import type { ComponentProps, ComponentType } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Group, GroupText } from "../ui/group";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { GitHubIssueSwatch, gitHubIssueChipName } from "./GitHubIssueChips";
import { ISSUE_CONTROL_LABEL } from "./GitHubIssueListControls";
import {
  GITHUB_ISSUE_FILTER_FIELD_LABEL,
  gitHubIssueFilterOperatorLabel,
  removeGitHubIssueFilter,
  setGitHubIssueFilter,
  toggleGitHubIssueNarrowing,
  type GitHubIssueFilter,
  type GitHubIssueFilterField,
  type GitHubIssueFilterOperator,
  type GitHubIssueListNarrowing,
} from "./GitHubIssueListView.logic";

/**
 * Linear's filter bar, built from the app's own controls. A filter is a row that reads as a
 * sentence — `Label` `is any of` `ui, dx` — with each word a control of its own: the operator is a
 * menu, the values a multi-select combobox, and the row ends in its own remove. New rows come from
 * the `Filter` trigger beside the search field, which offers only the types and labels the fetched
 * issues carry, so no pick can empty the list.
 */

export interface GitHubIssueFilterProps {
  readonly types: ReadonlyArray<GitHubIssueType>;
  readonly labels: ReadonlyArray<GitHubIssueLabel>;
  readonly narrowing: GitHubIssueListNarrowing;
  readonly onNarrowing: (narrowing: GitHubIssueListNarrowing) => void;
}

/** A type or label on offer, with the colour its swatch wears. */
interface Facet {
  readonly field: GitHubIssueFilterField;
  readonly name: string;
  readonly color: string | null;
}

interface FacetGroup {
  readonly value: GitHubIssueFilterField;
  readonly items: ReadonlyArray<Facet>;
}

const FIELD_ICON: Record<GitHubIssueFilterField, ComponentType<{ className?: string }>> = {
  type: ShapesIcon,
  label: TagIcon,
};

const OPERATORS = ["is", "is-not"] as const satisfies ReadonlyArray<GitHubIssueFilterOperator>;

const facets = (
  field: GitHubIssueFilterField,
  offered: ReadonlyArray<GitHubIssueType | GitHubIssueLabel>,
): Facet[] => offered.map((facet) => ({ field, name: facet.name, color: facet.color }));

const facetLabel = (facet: Facet) => gitHubIssueChipName(facet.field, facet.name);

const sameFacet = (left: Facet, right: Facet) =>
  left.field === right.field && left.name === right.name;

function FacetRow({ facet }: { readonly facet: Facet }) {
  return (
    <ComboboxItem value={facet}>
      <span className="flex items-center gap-2">
        <GitHubIssueSwatch kind={facet.field} color={facet.color} />
        <span className="min-w-0 flex-1 truncate">{facetLabel(facet)}</span>
        <CheckIcon className="opacity-0 in-data-selected:opacity-100" />
      </span>
    </ComboboxItem>
  );
}

/** The popup every picker here shares: a filter box on top, the rows beneath it. */
function FacetPopup({
  children,
}: {
  readonly children: ComponentProps<typeof ComboboxList>["children"];
}) {
  return (
    <ComboboxPopup align="start" className="w-60 min-w-0">
      <div className="border-border/70 border-b p-1">
        <ComboboxInput size="sm" showTrigger={false} placeholder="Filter…" />
      </div>
      <ComboboxEmpty>No matches</ComboboxEmpty>
      <ComboboxList className="max-h-72">{children}</ComboboxList>
    </ComboboxPopup>
  );
}

/**
 * The `Filter` control for the toolbar. One pick adds the name to its field's row, creating the
 * row when the field has none yet, and the popup closes on it the way a command palette does.
 */
export function GitHubIssueFilterAdd({
  types,
  labels,
  narrowing,
  onNarrowing,
}: GitHubIssueFilterProps) {
  const groups = (
    [
      { value: "type", items: facets("type", types) },
      { value: "label", items: facets("label", labels) },
    ] satisfies FacetGroup[]
  ).filter((group) => group.items.length > 0);
  return (
    <Combobox
      items={groups}
      value={null}
      autoHighlight
      isItemEqualToValue={sameFacet}
      itemToStringLabel={facetLabel}
      onValueChange={(facet: Facet | null) => {
        if (facet) onNarrowing(toggleGitHubIssueNarrowing(narrowing, facet.field, facet.name));
      }}
    >
      <ComboboxTrigger
        render={<Button size="sm" variant="outline" aria-label="Add a filter" />}
        disabled={groups.length === 0}
      >
        <ListFilterIcon className="size-4" />
        <span className={ISSUE_CONTROL_LABEL}>Filter</span>
      </ComboboxTrigger>
      <FacetPopup>
        {(group: FacetGroup) => (
          <ComboboxGroup key={group.value} items={group.items}>
            <ComboboxGroupLabel>{GITHUB_ISSUE_FILTER_FIELD_LABEL[group.value]}</ComboboxGroupLabel>
            <ComboboxCollection>
              {(facet: Facet) => <FacetRow key={facet.name} facet={facet} />}
            </ComboboxCollection>
          </ComboboxGroup>
        )}
      </FacetPopup>
    </Combobox>
  );
}

/** One row: `[field] [operator ▾] [values ▾] [×]`, joined as a single control group. */
function GitHubIssueFilterRow({
  filter,
  offered,
  onFilter,
  onRemove,
}: {
  readonly filter: GitHubIssueFilter;
  readonly offered: ReadonlyArray<Facet>;
  readonly onFilter: (filter: GitHubIssueFilter) => void;
  readonly onRemove: () => void;
}) {
  const FieldIcon = FIELD_ICON[filter.field];
  const field = GITHUB_ISSUE_FILTER_FIELD_LABEL[filter.field];
  // A value applied from a row that a later fetch no longer returns keeps its place, uncoloured.
  const selected = filter.values.map(
    (name) =>
      offered.find((facet) => facet.name === name) ?? { field: filter.field, name, color: null },
  );
  const count = filter.values.length;
  return (
    <Group className="max-w-full text-xs">
      <GroupText className="h-auto gap-1.5 rounded-md px-2 text-xs sm:text-xs">
        <FieldIcon className="size-3.5" />
        {field}
      </GroupText>
      <Menu>
        <MenuTrigger
          render={<Button size="xs" variant="outline" aria-label={`${field} filter operator`} />}
        >
          {gitHubIssueFilterOperatorLabel(filter.operator, count)}
        </MenuTrigger>
        <MenuPopup align="start" side="bottom" className="min-w-36">
          <MenuRadioGroup
            value={filter.operator}
            onValueChange={(next) => {
              if (next !== filter.operator) {
                onFilter({ ...filter, operator: next as GitHubIssueFilterOperator });
              }
            }}
          >
            {OPERATORS.map((operator) => (
              <MenuRadioItem key={operator} value={operator} closeOnClick>
                {gitHubIssueFilterOperatorLabel(operator, count)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      <Combobox
        multiple
        autoHighlight
        items={offered}
        value={selected}
        isItemEqualToValue={sameFacet}
        itemToStringLabel={facetLabel}
        onValueChange={(next: ReadonlyArray<Facet>) =>
          onFilter({ ...filter, values: next.map((facet) => facet.name) })
        }
      >
        <ComboboxTrigger
          render={<Button size="xs" variant="outline" aria-label={`${field} filter values`} />}
          className="min-w-0"
        >
          <span className="flex shrink-0 items-center -space-x-1">
            {selected.slice(0, 3).map((facet) => (
              <GitHubIssueSwatch key={facet.name} kind={facet.field} color={facet.color} />
            ))}
          </span>
          <span className="min-w-0 max-w-48 truncate">
            {count === 1 && selected[0] ? facetLabel(selected[0]) : `${count} selected`}
          </span>
        </ComboboxTrigger>
        <FacetPopup>{(facet: Facet) => <FacetRow key={facet.name} facet={facet} />}</FacetPopup>
      </Combobox>
      <Button
        size="icon-xs"
        variant="outline"
        aria-label={`Remove ${field} filter`}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </Group>
  );
}

/** The applied rows, wrapping as a line under the toolbar; renders nothing while none apply. */
export function GitHubIssueFilterBar({
  types,
  labels,
  narrowing,
  onNarrowing,
}: GitHubIssueFilterProps) {
  if (narrowing.length === 0) return null;
  const offered: Record<GitHubIssueFilterField, ReadonlyArray<Facet>> = {
    type: facets("type", types),
    label: facets("label", labels),
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {narrowing.map((filter) => (
        <GitHubIssueFilterRow
          key={filter.field}
          filter={filter}
          offered={offered[filter.field]}
          onFilter={(next) => onNarrowing(setGitHubIssueFilter(narrowing, next))}
          onRemove={() => onNarrowing(removeGitHubIssueFilter(narrowing, filter.field))}
        />
      ))}
    </div>
  );
}
