// A suite run by an agent under a T3 trial server inherits that server's
// launcher context, whose pending update points at the live database. Launcher
// fixtures write to that path, so no test may see it (RSI-Software/t3code-hyprws#1707).
delete process.env.T3_SERVICE_LAUNCHER_CONTEXT;
