const authService = require("../services/auth.service");

const login = async (req, res) => {
  const data = await authService.login(req.body);
  return res.success({ data, message: "Signed in" });
};

const refresh = async (req, res) => {
  const data = await authService.refresh(req.body);
  return res.success({ data, message: "Session refreshed" });
};

const me = async (req, res) => res.success({ data: req.user });

const logout = async (req, res) => {
  await authService.logout(req.accessToken);
  require("../../middleware/auth").forget(req.accessToken);
  return res.success({ message: "Signed out" });
};

module.exports = { login, refresh, me, logout };