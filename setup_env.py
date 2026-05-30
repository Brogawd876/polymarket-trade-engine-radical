#!/usr/bin/env python3
"""
Tkinter .env setup form for the Polymarket trade engine.

Run by double-clicking setup_env_click_me.bat, or from the repo root:
  python setup_env.py

This writes a local .env file. The .env file is gitignored; do not share it.
"""

from __future__ import annotations

from pathlib import Path
import re
import tkinter as tk
from tkinter import messagebox, ttk


ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env"
BACKUP_PATH = ROOT / ".env.backup"

ADDRESS_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")
PRIVATE_KEY_RE = re.compile(r"^0x[a-fA-F0-9]{64}$")


DEFAULTS = {
    "TICKER": "polymarket,coinbase",
    "MARKET_ASSET": "btc",
    "MARKET_WINDOW": "5m",
    "PRIVATE_KEY": "",
    "POLY_FUNDER_ADDRESS": "",
    "POLY_SIGNATURE_TYPE": "3",
    "BUILDER_KEY": "",
    "BUILDER_SECRET": "",
    "BUILDER_PASSPHRASE": "",
    "OPERATOR_AUTH_TOKEN": "",
    "FORCE_PROD": "false",
    "MAX_SESSION_LOSS": "3",
    "MAX_SESSION_PROFIT": "0.50",
    "WALLET_BALANCE": "50",
    "CHAINLINK_BTC_5M_REFERENCE_VERIFIED": "false",
}


HELP = {
    "TICKER": "Default data sources. Leave this alone for BTC 5m.",
    "MARKET_ASSET": "Default is btc.",
    "MARKET_WINDOW": "Default is 5m.",
    "PRIVATE_KEY": "Private key for the dedicated MetaMask bot account. Hidden.",
    "POLY_FUNDER_ADDRESS": "Type 3 deposit wallet derived from the PRIVATE_KEY owner; do not copy between owners.",
    "POLY_SIGNATURE_TYPE": "Use 3 for the proven POLY_1271 deposit-wallet flow.",
    "POLY_API_KEY_NONCE": "Integer nonce used to derive CLOB API keys. Default is 1.",
    "POLYGON_RPC_URL": "Primary Polygon JSON-RPC endpoint.",
    "BUILDER_KEY": "Optional Polymarket Builder Code key.",
    "BUILDER_SECRET": "Optional Polymarket Builder Code secret. Hidden.",
    "BUILDER_PASSPHRASE": "Optional Polymarket Builder Code passphrase. Hidden.",
    "OPERATOR_AUTH_TOKEN": "Optional local control-panel password. Hidden.",
    "FORCE_PROD": "Keep false so live runs still ask for confirmation.",
    "MAX_SESSION_LOSS": "Session loss cap in dollars.",
    "MAX_SESSION_PROFIT": "Session profit target in dollars. Bot will exit once reached.",
    "WALLET_BALANCE": "Paper/simulation wallet balance.",
    "CHAINLINK_BTC_5M_REFERENCE_VERIFIED": "Keep false until BTC 5m settlement reference is verified.",
}



def parse_env_file() -> dict[str, str]:
    values = DEFAULTS.copy()
    if not ENV_PATH.exists():
        return values

    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key in values:
            values[key] = value
    return values


def mask_entry(parent: tk.Widget, textvariable: tk.StringVar) -> ttk.Entry:
    frame = ttk.Frame(parent)
    entry = ttk.Entry(frame, textvariable=textvariable, show="*", width=44)
    entry.pack(side="left", fill="x", expand=True)

    visible = tk.BooleanVar(value=False)

    def toggle() -> None:
        entry.configure(show="" if visible.get() else "*")

    ttk.Checkbutton(frame, text="show", variable=visible, command=toggle).pack(
        side="left", padx=(8, 0)
    )
    return frame  # type: ignore[return-value]


class EnvSetupApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Polymarket Bot .env Setup")
        self.geometry("760x720")
        self.minsize(700, 620)

        self.values = parse_env_file()
        self.vars: dict[str, tk.StringVar] = {
            key: tk.StringVar(value=value) for key, value in self.values.items()
        }

        self._build()

    def _build(self) -> None:
        root = ttk.Frame(self, padding=16)
        root.pack(fill="both", expand=True)

        title = ttk.Label(
            root,
            text="Polymarket Bot Setup",
            font=("Segoe UI", 16, "bold"),
        )
        title.pack(anchor="w")

        subtitle = ttk.Label(
            root,
            text="Defaults are already set for BTC 5-minute Type 3 trading. Fill the owner key and its derived deposit wallet, add Builder Codes only for wrap/unwrap/redeem, then Save .env.",
            wraplength=700,
        )
        subtitle.pack(anchor="w", pady=(4, 12))

        canvas = tk.Canvas(root, highlightthickness=0)
        scrollbar = ttk.Scrollbar(root, orient="vertical", command=canvas.yview)
        form = ttk.Frame(canvas)
        form.bind(
            "<Configure>",
            lambda _event: canvas.configure(scrollregion=canvas.bbox("all")),
        )
        canvas.create_window((0, 0), window=form, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        row = 0
        row = self._section(form, row, "Trading Defaults")
        row = self._field(form, row, "TICKER")
        row = self._choice(form, row, "MARKET_ASSET", ("btc", "eth", "xrp", "sol", "doge"))
        row = self._choice(form, row, "MARKET_WINDOW", ("5m", "15m"))

        row = self._section(form, row, "Wallet / Login")
        row = self._field(form, row, "PRIVATE_KEY", secret=True)
        row = self._field(form, row, "POLY_FUNDER_ADDRESS")
        row = self._choice(
            form,
            row,
            "POLY_SIGNATURE_TYPE",
            (
                "0 - EOA / normal MetaMask wallet",
                "1 - POLY_PROXY / Magic wallet",
                "2 - POLY_GNOSIS_SAFE",
                "3 - POLY_1271 / deposit-wallet flow",
            ),
            normalize=lambda value: value.split(" ", 1)[0],
            display=lambda value: next(
                item
                for item in (
                    "0 - EOA / normal MetaMask wallet",
                    "1 - POLY_PROXY / Magic wallet",
                    "2 - POLY_GNOSIS_SAFE",
                    "3 - POLY_1271 / deposit-wallet flow",
                )
                if item.startswith(value)
            ),
        )
        row = self._section(form, row, "Builder Codes Optional")
        row = self._field(form, row, "BUILDER_KEY", secret=True)
        row = self._field(form, row, "BUILDER_SECRET", secret=True)
        row = self._field(form, row, "BUILDER_PASSPHRASE", secret=True)

        row = self._section(form, row, "Safety / Runtime")
        row = self._field(form, row, "OPERATOR_AUTH_TOKEN", secret=True)
        row = self._choice(form, row, "FORCE_PROD", ("false", "true"))
        row = self._field(form, row, "MAX_SESSION_LOSS")
        row = self._field(form, row, "MAX_SESSION_PROFIT")
        row = self._field(form, row, "WALLET_BALANCE")
        row = self._choice(
            form,
            row,
            "CHAINLINK_BTC_5M_REFERENCE_VERIFIED",
            ("false", "true"),
        )

        buttons = ttk.Frame(root)
        buttons.pack(fill="x", pady=(12, 0))
        ttk.Button(buttons, text="Save .env", command=self.save).pack(side="right")
        ttk.Button(buttons, text="Quit", command=self.destroy).pack(side="right", padx=(0, 8))

    def _section(self, parent: ttk.Frame, row: int, text: str) -> int:
        label = ttk.Label(parent, text=text, font=("Segoe UI", 11, "bold"))
        label.grid(row=row, column=0, columnspan=3, sticky="w", pady=(14, 6))
        return row + 1

    def _field(self, parent: ttk.Frame, row: int, key: str, secret: bool = False) -> int:
        ttk.Label(parent, text=key).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=4)
        if secret:
            widget = mask_entry(parent, self.vars[key])
            widget.grid(row=row, column=1, sticky="ew", pady=4)
        else:
            ttk.Entry(parent, textvariable=self.vars[key], width=54).grid(
                row=row, column=1, sticky="ew", pady=4
            )
        ttk.Label(parent, text=HELP[key], wraplength=230).grid(
            row=row, column=2, sticky="w", padx=(12, 0), pady=4
        )
        parent.columnconfigure(1, weight=1)
        return row + 1

    def _choice(
        self,
        parent: ttk.Frame,
        row: int,
        key: str,
        choices: tuple[str, ...],
        normalize=None,
        display=None,
    ) -> int:
        if display:
            self.vars[key].set(display(self.vars[key].get()))
        ttk.Label(parent, text=key).grid(row=row, column=0, sticky="w", padx=(0, 12), pady=4)
        box = ttk.Combobox(
            parent,
            textvariable=self.vars[key],
            values=choices,
            state="readonly",
            width=51,
        )
        box.grid(row=row, column=1, sticky="ew", pady=4)
        box.normalize_value = normalize  # type: ignore[attr-defined]
        ttk.Label(parent, text=HELP[key], wraplength=230).grid(
            row=row, column=2, sticky="w", padx=(12, 0), pady=4
        )
        parent.columnconfigure(1, weight=1)
        return row + 1

    def _normalized(self, key: str) -> str:
        value = self.vars[key].get().strip()
        if key == "POLY_SIGNATURE_TYPE":
            return value.split(" ", 1)[0]
        return value

    def validate(self) -> bool:
        private_key = self._normalized("PRIVATE_KEY")
        if private_key and not private_key.startswith("0x"):
            private_key = f"0x{private_key}"
            self.vars["PRIVATE_KEY"].set(private_key)
        if not PRIVATE_KEY_RE.match(private_key):
            messagebox.showerror(
                "Invalid private key",
                "PRIVATE_KEY must be 0x followed by 64 hex characters.",
            )
            return False

        funder = self._normalized("POLY_FUNDER_ADDRESS")
        if not ADDRESS_RE.match(funder):
            messagebox.showerror(
                "Invalid funder address",
                "POLY_FUNDER_ADDRESS must be 0x followed by 40 hex characters.",
            )
            return False

        signature_type = self._normalized("POLY_SIGNATURE_TYPE")
        if signature_type not in {"0", "1", "2", "3"}:
            messagebox.showerror("Invalid signature type", "POLY_SIGNATURE_TYPE must be 0, 1, 2, or 3.")
            return False

        builder_values = [
            self._normalized("BUILDER_KEY"),
            self._normalized("BUILDER_SECRET"),
            self._normalized("BUILDER_PASSPHRASE"),
        ]
        if any(builder_values) and not all(builder_values):
            messagebox.showerror(
                "Incomplete Builder Codes",
                "Fill all three Builder Code fields, or leave all three blank.",
            )
            return False

        for key in ("FORCE_PROD", "CHAINLINK_BTC_5M_REFERENCE_VERIFIED"):
            if self._normalized(key) not in {"false", "true"}:
                messagebox.showerror("Invalid boolean", f"{key} must be false or true.")
                return False

        return True

    def save(self) -> None:
        if not self.validate():
            return

        if ENV_PATH.exists():
            overwrite = messagebox.askyesno(
                "Overwrite .env?",
                ".env already exists. Overwrite it? A backup will be saved as .env.backup.",
            )
            if not overwrite:
                return
            BACKUP_PATH.write_text(ENV_PATH.read_text(encoding="utf-8"), encoding="utf-8")

        env_text = f"""TICKER={self._normalized("TICKER")}
MARKET_ASSET={self._normalized("MARKET_ASSET")}
MARKET_WINDOW={self._normalized("MARKET_WINDOW")}

PRIVATE_KEY={self._normalized("PRIVATE_KEY")}
POLY_FUNDER_ADDRESS={self._normalized("POLY_FUNDER_ADDRESS")}
POLY_SIGNATURE_TYPE={self._normalized("POLY_SIGNATURE_TYPE")}

BUILDER_KEY={self._normalized("BUILDER_KEY")}
BUILDER_SECRET={self._normalized("BUILDER_SECRET")}
BUILDER_PASSPHRASE={self._normalized("BUILDER_PASSPHRASE")}

OPERATOR_AUTH_TOKEN={self._normalized("OPERATOR_AUTH_TOKEN")}
FORCE_PROD={self._normalized("FORCE_PROD")}
MAX_SESSION_LOSS={self._normalized("MAX_SESSION_LOSS")}
MAX_SESSION_PROFIT={self._normalized("MAX_SESSION_PROFIT")}
WALLET_BALANCE={self._normalized("WALLET_BALANCE")}

CHAINLINK_BTC_5M_REFERENCE_VERIFIED={self._normalized("CHAINLINK_BTC_5M_REFERENCE_VERIFIED")}
"""

        ENV_PATH.write_text(env_text, encoding="utf-8")
        messagebox.showinfo(
            "Saved",
            ".env was written successfully.\n\nNo trades were placed. No funds were moved.",
        )


if __name__ == "__main__":
    EnvSetupApp().mainloop()
