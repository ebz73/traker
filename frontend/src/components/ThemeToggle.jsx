import { Moon, Monitor, Sun } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useThemeContext } from '../context/ThemeContext'

export default function ThemeToggle() {
  const { preference, setTheme } = useThemeContext()

  const handleValueChange = (value) => {
    if (value === 'light' || value === 'auto' || value === 'dark') {
      setTheme(value)
    }
  }

  return (
    <ToggleGroup
      type="single"
      value={preference}
      onValueChange={handleValueChange}
      spacing={1.5}
      aria-label="Theme preference"
      className="w-full"
    >
      <ToggleGroupItem
        value="light"
        aria-label="Light mode"
        className="flex-1 h-11 gap-1.5 rounded-xl border border-transparent hover:bg-(--bg-hover) data-[state=on]:border-(--purple) data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent data-[state=on]:shadow-[0_0_0_2px_var(--shadow-ring-strong)]"
      >
        <Sun className="size-4.5" />
        <span className="text-sm">Light</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        value="auto"
        aria-label="Use system theme"
        className="flex-1 h-11 gap-1.5 rounded-xl border border-transparent hover:bg-(--bg-hover) data-[state=on]:border-(--purple) data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent data-[state=on]:shadow-[0_0_0_2px_var(--shadow-ring-strong)]"
      >
        <Monitor className="size-4.5" />
        <span className="text-sm">Auto</span>
      </ToggleGroupItem>
      <ToggleGroupItem
        value="dark"
        aria-label="Dark mode"
        className="flex-1 h-11 gap-1.5 rounded-xl border border-transparent hover:bg-(--bg-hover) data-[state=on]:border-(--purple) data-[state=on]:bg-transparent data-[state=on]:hover:bg-transparent data-[state=on]:shadow-[0_0_0_2px_var(--shadow-ring-strong)]"
      >
        <Moon className="size-4.5" />
        <span className="text-sm">Dark</span>
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
