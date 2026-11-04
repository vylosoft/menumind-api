module.exports = (req, res) => {
  res.status(404).json({ success: false, error: true, message: "Route not found" });
};
