import type { IssueLabel, GitHubIssueType } from "@t3tools/contracts";
import { CheckIcon, ListFilterIcon, ShapesIcon, TagIcon, XIcon } from "lucide-react";
import type { ComponentProps, ComponentType } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Group } from "../ui/group";
import {
  ComboboxCollection,
  ComboboxGroup,
  ComboboxGroupLabel,
  GroupText,
} from "./IssueFilterPrimitives.fork";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { IssueSwatch, issueChipName } from "./IssueChips";
import { ISSUE_CONTROL_LABEL } from "./IssueListControls";
import {
  ISSUE_FILTER_FIELD_LABEL,
  issueFilterOperatorLabel,
  removeIssueFilter,
  setIssueFilter,
  toggleIssueNarrowing,
  type IssueFilter,
  type IssueFilterField,
  type IssueFilterOperator,
  type IssueListNarrowing,
} from "./IssueListView.logic";

/**
 * Linear's filter bar from the app's own controls: each row reads as a sentence (`Label`
 * `is any of` `ui, dx`) with an operator menu, a values combobox, and a remove. The `Filter`
 * trigger offers only the types and labels the fetched issues carry, so no pick can empty the list.
 */

export interface IssueFilterProps {
  readonly types: ReadonlyArray<GitHubIssueType>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly narrowing: IssueListNarrowing;
  readonly onNarrowing: (narrowing: IssueListNarrowing) => void;
}

/** A type or label on offer, with the colour its swatch wears. */
interface Facet {
  readonly field: IssueFilterField;
  readonly name: string;
  readonly color: string | null;
}

interface FacetGroup {
  readonly value: IssueFilterField;
  readonly items: ReadonlyArray<Facet>;
}

const FIELD_ICON: Record<IssueFilterField, ComponentType<{ className?: string }>> = {
  type: ShapesIcon,
  label: TagIcon,
};

const OPERATORS = ["is", "is-not"] as const satisfies ReadonlyArray<IssueFilterOperator>;

const facets = (
  field: IssueFilterField,
  offered: ReadonlyArray<GitHubIssueType | IssueLabel>,
): Facet[] => offered.map((facet) => ({ field, name: facet.name, color: facet.color }));

const facetLabel = (facet: Facet) => issueChipName(facet.field, facet.name);

const sameFacet = (left: Facet, right: Facet) =>
  left.field === right.field && left.name === right.name;

function FacetRow({ facet }: { readonly facet: Facet }) {
  return (
    <ComboboxItem value={facet}>
      <span className="flex items-center gap-2">
        <IssueSwatch kind={facet.field} color={facet.color} />
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
export function IssueFilterAdd({ types, labels, narrowing, onNarrowing }: IssueFilterProps) {
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
        if (facet) onNarrowing(toggleIssueNarrowing(narrowing, facet.field, facet.name));
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
            <ComboboxGroupLabel>{ISSUE_FILTER_FIELD_LABEL[group.value]}</ComboboxGroupLabel>
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
function IssueFilterRow({
  filter,
  offered,
  onFilter,
  onRemove,
}: {
  readonly filter: IssueFilter;
  readonly offered: ReadonlyArray<Facet>;
  readonly onFilter: (filter: IssueFilter) => void;
  readonly onRemove: () => void;
}) {
  const FieldIcon = FIELD_ICON[filter.field];
  const field = ISSUE_FILTER_FIELD_LABEL[filter.field];
  // A value applied from a row that a later fetch no longer returns keeps its place, uncoloured.
  const selected = filter.values.map(
    (name) =>
      offered.find((facet) => facet.name === name) ?? { field: filter.field, name, color: null },
  );
  const count = filter.values.length;
  return (
    <Group className="max-w-full">
      <GroupText>
        <FieldIcon className="size-3.5" />
        {field}
      </GroupText>
      <Menu>
        <MenuTrigger
          render={<Button size="xs" variant="outline" aria-label={`${field} filter operator`} />}
        >
          {issueFilterOperatorLabel(filter.operator, count)}
        </MenuTrigger>
        <MenuPopup align="start" side="bottom" className="min-w-36">
          <MenuRadioGroup
            value={filter.operator}
            onValueChange={(next) => {
              if (next !== filter.operator) {
                onFilter({ ...filter, operator: next as IssueFilterOperator });
              }
            }}
          >
            {OPERATORS.map((operator) => (
              <MenuRadioItem key={operator} value={operator} closeOnClick>
                {issueFilterOperatorLabel(operator, count)}
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
              <IssueSwatch key={facet.name} kind={facet.field} color={facet.color} />
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
export function IssueFilterBar({ types, labels, narrowing, onNarrowing }: IssueFilterProps) {
  if (narrowing.length === 0) return null;
  const offered: Record<IssueFilterField, ReadonlyArray<Facet>> = {
    type: facets("type", types),
    label: facets("label", labels),
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {narrowing.map((filter) => (
        <IssueFilterRow
          key={filter.field}
          filter={filter}
          offered={offered[filter.field]}
          onFilter={(next) => onNarrowing(setIssueFilter(narrowing, next))}
          onRemove={() => onNarrowing(removeIssueFilter(narrowing, filter.field))}
        />
      ))}
    </div>
  );
}
