import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import AppIcon from "./AppIcon";
import { matchesSelectSearch, selectSearchIndex } from "../lib/selectSearch";

interface SearchableSelectProps<T extends { id: string }> {
  items: T[];
  value: string;
  onSelect: (item: T) => void;
  onSearch?: (keyword: string) => void | Promise<void>;
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
  renderItem?: (item: T) => React.ReactNode;
  getItemName?: (item: T) => string;
  getItemSearchTerms?: (item: T) => string[];
  ariaLabel?: string;
}

export default function SearchableSelect<T extends { id: string }>({
  items,
  value,
  onSelect,
  onSearch,
  loading,
  placeholder,
  disabled,
  renderItem,
  getItemName,
  getItemSearchTerms,
  ariaLabel,
}: SearchableSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const defaultName = (item: T) => {
    if (getItemName) return getItemName(item);
    const candidate = (item as { name?: string }).name;
    return candidate || item.id;
  };

  const selected = items.find((item) => item.id === value);
  const indexed = useMemo(() => items.map(item => ({ item, search: selectSearchIndex([defaultName(item), item.id, ...(getItemSearchTerms?.(item) || [])]) })), [items, getItemName, getItemSearchTerms]);
  const displayItems = onSearch ? items : indexed.filter(({ search }) => matchesSelectSearch(search, keyword)).map(({ item }) => item);

  useEffect(() => { setKeyword(""); }, [value]);
  useEffect(() => { setActiveIndex(0); }, [keyword, items]);
  useEffect(() => { if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" }); }, [open, activeIndex, listId]);

  useEffect(() => {
    if (open && items.length === 0 && onSearch) {
      void triggerSearch("");
    }
  }, [open]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const triggerSearch = async (q: string) => {
    if (!onSearch) return;
    setSearching(true);
    try {
      await onSearch(q);
    } finally {
      setSearching(false);
    }
  };

  const handleInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const q = event.target.value;
    setKeyword(q);
    if (onSearch) {
      void triggerSearch(q);
    }
    setOpen(true);
  };

  const handleFocus = () => {
    setKeyword("");
    setOpen(true);
    if (items.length === 0 && onSearch) {
      void triggerSearch(keyword);
    }
  };

  const handleSelect = (item: T) => {
    onSelect(item);
    setKeyword("");
    setOpen(false);
  };

  return (
    <div className={open ? "searchable-select open" : "searchable-select"} ref={wrapperRef}>
      <div className="searchable-select-input">
        <input
          className="field-input"
          type="text"
          value={open ? keyword : (selected ? defaultName(selected) : "")}
          onChange={handleInput}
          onFocus={handleFocus}
          placeholder={placeholder}
          disabled={disabled}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && displayItems[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" || event.key === "Tab") { setOpen(false); setKeyword(""); return; }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); setOpen(true);
              if (displayItems.length) setActiveIndex(index => !open ? (event.key === "ArrowDown" ? 0 : displayItems.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + displayItems.length) % displayItems.length);
            }
            if (event.key === "Enter" && open) { event.preventDefault(); if (displayItems[activeIndex]) handleSelect(displayItems[activeIndex]); }
          }}
        />
        {(loading || searching) && <span className="spinner" />}
        {!loading && !searching && <AppIcon name="down" size={14} />}
      </div>
      {open && (
        <div className="searchable-select-dropdown" id={listId} role="listbox">
          {displayItems.length === 0 ? (
            <div className="searchable-select-empty">无匹配结果</div>
          ) : (
            displayItems.map((item, index) => (
              <div
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={item.id === value}
                className={`searchable-select-option ${item.id === value ? "selected" : ""} ${index === activeIndex ? "highlighted" : ""}`}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => handleSelect(item)}
              >
                {renderItem ? renderItem(item) : defaultName(item)}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
