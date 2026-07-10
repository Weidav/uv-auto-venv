
import getpass
import termcolor

def main():
    print(termcolor.colored("Hello from example-bare!", "green"))
    user = getpass.getuser()
    print(termcolor.colored(f"Whoami? You are currently logged in as: {user}", "blue"))

if __name__ == "__main__":
    main()
