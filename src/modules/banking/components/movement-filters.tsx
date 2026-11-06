"use client";

import { useEffect, useRef, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { BankMovementFilters } from "@/modules/banking/types";

export interface MovementFiltersProps {
  filters: BankMovementFilters;
}

const SEARCH_DEBOUNCE_MS = 300;
export function MovementFilters({
  filters,
}: MovementFiltersProps) {
  const t = useTranslations("BankMovements");
  const pathname = usePathname();
  const router = useRouter();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  function apply(changes: Record<string, string>) {
    const params = new URLSearchParams(window.location.search);
    for (const [name, value] of Object.entries(changes)) {
      if (value) {
        params.set(name, value);
      } else {
        params.delete(name);
      }
    }
    params.delete("direction");
    params.delete("page");

    startTransition(() => {
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  return (
    <form
      method="get"
      aria-busy={pending}
      onSubmit={(event) => event.preventDefault()}
    >
      <FieldGroup className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field>
          <FieldLabel htmlFor="movement-from">{t("filters.from")}</FieldLabel>
          <Input
            id="movement-from"
            name="from"
            type="date"
            defaultValue={filters.from ?? ""}
            onChange={(event) => apply({ from: event.target.value })}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="movement-to">{t("filters.to")}</FieldLabel>
          <Input
            id="movement-to"
            name="to"
            type="date"
            defaultValue={filters.to ?? ""}
            onChange={(event) => apply({ to: event.target.value })}
          />
        </Field>

        <Field className="sm:col-span-2 xl:col-span-2">
          <FieldLabel htmlFor="movement-search">
            {t("filters.search")}
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id="movement-search"
              name="q"
              type="search"
              maxLength={100}
              defaultValue={filters.q}
              onChange={(event) => {
                const value = event.target.value;
                if (searchTimer.current) clearTimeout(searchTimer.current);
                searchTimer.current = setTimeout(
                  () => apply({ q: value.trim() }),
                  SEARCH_DEBOUNCE_MS,
                );
              }}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (searchTimer.current) clearTimeout(searchTimer.current);
                startTransition(() => router.replace(pathname, { scroll: false }));
              }}
            >
              {t("clearFilters")}
            </Button>
          </div>
        </Field>
      </FieldGroup>
    </form>
  );
}