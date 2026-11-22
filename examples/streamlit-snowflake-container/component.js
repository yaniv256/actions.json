export default function({ parentElement, data, setTriggerValue }) {
  const root = parentElement.querySelector(".probe");
  const button = root.querySelector("button");
  const output = root.querySelector("pre");

  output.textContent = data?.response
    ? JSON.stringify(data.response, null, 2)
    : "Ready";
  button.disabled = false;

  button.onclick = () => {
    button.disabled = true;
    output.textContent = "Reading…";
    setTriggerValue("action", data.call);
  };
}
