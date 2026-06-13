import type { Command } from "commander";
import { badInput } from "../output/exit";

const COMMANDS = "search read fetch extract feedback auth config api completion update version";
const SEARCH_FLAGS = "--mode --max-results --format --json --output --key --base-url --no-retry --timeout";
const READ_FLAGS =
  "--query --max-chars --start-char --include --json --output --key --base-url --no-retry --timeout";

const BASH = `# bash completion for caesar-search
_caesar_search() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS}" -- "$cur") )
    return
  fi
  case "$prev" in
    search) COMPREPLY=( $(compgen -W "${SEARCH_FLAGS}" -- "$cur") );;
    read|fetch|extract) COMPREPLY=( $(compgen -W "${READ_FLAGS}" -- "$cur") );;
    auth) COMPREPLY=( $(compgen -W "status login logout" -- "$cur") );;
    config) COMPREPLY=( $(compgen -W "get set unset list path" -- "$cur") );;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") );;
  esac
}
complete -F _caesar_search caesar-search
`;

const ZSH = `#compdef caesar-search
_caesar_search() {
  local -a commands
  commands=(${COMMANDS})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  fi
}
_caesar_search "$@"
`;

const FISH = `complete -c caesar-search -n "__fish_use_subcommand" -a "${COMMANDS}"
complete -c caesar-search -n "__fish_seen_subcommand_from auth" -a "status login logout"
complete -c caesar-search -n "__fish_seen_subcommand_from config" -a "get set unset list path"
complete -c caesar-search -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"
`;

export function registerCompletion(program: Command): void {
  program
    .command("completion")
    .description("Print a shell completion script. Eval it from your shell rc file.")
    .argument("<shell>", "bash | zsh | fish")
    .action(async (shell: string) => {
      switch (shell) {
        case "bash":
          process.stdout.write(BASH);
          break;
        case "zsh":
          process.stdout.write(ZSH);
          break;
        case "fish":
          process.stdout.write(FISH);
          break;
        default:
          throw badInput("shell must be bash, zsh, or fish");
      }
    });
}
